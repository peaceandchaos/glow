import type { ModelKey, ResponseInputItem } from '../../../shared/contracts';
import { parseGatewayEvent, SseDecoder } from '../../../shared/provider-events';
import { ProviderFailure } from './errors';
import { models } from './models';
import type { BeforePaidCall, ProviderChunk } from './provider';

type GatewayPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
type GatewayMessage = {
  role: 'user' | 'assistant' | 'system';
  content: GatewayPart[];
};

export function gatewayMessages(items: ResponseInputItem[]): GatewayMessage[] {
  return items.map(item => {
    if (item.type !== 'message')
      throw new ProviderFailure(
        'This provider cannot read an OpenAI context item.',
      );
    return {
      role: item.role,
      content: item.content.map(part =>
        part.type === 'input_image'
          ? { type: 'image_url', image_url: { url: part.image_url } }
          : { type: 'text', text: part.text },
      ),
    };
  });
}

type GatewayOptions = {
  apiKey: string;
  endpoint?: string;
  fetcher?: typeof fetch;
};

export class GatewayClient {
  constructor(private readonly options: GatewayOptions) {}

  async generate(
    model: ModelKey,
    items: ResponseInputItem[],
    signal: AbortSignal,
    beforeCall: BeforePaidCall,
    onChunk: (chunk: ProviderChunk) => Promise<void>,
    maxOutput = models[model].maxOutput,
  ): Promise<string> {
    const messages = gatewayMessages(items);
    await beforeCall();
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(
        this.options.endpoint ??
          'https://ai-gateway.vercel.sh/v1/chat/completions',
        {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: models[model].id,
            messages,
            stream: true,
            max_tokens: maxOutput,
          }),
        },
      );
    } catch {
      throw new ProviderFailure(
        'The provider connection was interrupted. Retry creates a new answer.',
        true,
      );
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ProviderFailure(
        `The provider rejected this request (HTTP ${response.status}).`,
      );
    }
    return this.read(response.body, signal, onChunk);
  }

  private async read(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    onChunk: (chunk: ProviderChunk) => Promise<void>,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const records = new SseDecoder();
    let text = '';
    let done = false;
    let stopped = false;
    const handle = async (raw: string) => {
      if (done)
        throw new ProviderFailure('The provider sent data after completion.');
      const event = parseGatewayEvent(raw);
      if (event.kind === 'error') throw new ProviderFailure(event.message);
      if (event.kind === 'ignored' && event.type === 'stop') stopped = true;
      if (event.kind === 'delta' && event.stopped) stopped = true;
      if (event.kind === 'completed') done = true;
      const delta = event.kind === 'delta' ? event.text : undefined;
      if (delta) text += delta;
      await onChunk({ wire: 'gateway', raw, text: delta });
    };
    try {
      while (!done) {
        signal.throwIfAborted();
        const chunk = await reader.read().catch(() => {
          throw new ProviderFailure(
            'The provider connection was interrupted. Retry creates a new answer.',
            true,
          );
        });
        if (chunk.done) break;
        for (const raw of records.push(
          decoder.decode(chunk.value, { stream: true }),
        ))
          await handle(raw);
      }
      for (const raw of records.push(decoder.decode())) await handle(raw);
      records.finish();
      if (!done || !stopped || !text.trim())
        throw new ProviderFailure(
          'The provider stream ended without a complete answer.',
          true,
        );
      return text;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
