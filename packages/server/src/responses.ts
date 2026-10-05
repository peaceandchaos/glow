import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import {
  decodeJson,
  responseInputItemSchema,
  type ResponseInputItem,
} from '../../../shared/contracts';
import { parseResponsesEvent } from '../../../shared/provider-events';
import { ProviderFailure } from './errors';
import type { ResponsesModel } from './models';
import type { BeforePaidCall, ProviderChunk } from './provider';

// Strip API-only fields (annotations, item status) while preserving every replay item.
const outputItemSchema = z.union([
  z.object({
    type: z.literal('message'),
    role: z.enum(['user', 'assistant', 'system']),
    content: z.array(
      z.union([
        z.object({
          type: z.enum(['input_text', 'output_text']),
          text: z.string(),
        }),
        z.object({ type: z.literal('input_image'), image_url: z.string() }),
        z
          .object({ type: z.literal('refusal'), refusal: z.string() })
          .transform(part => ({
            type: 'output_text' as const,
            text: part.refusal,
          })),
      ]),
    ),
  }),
  z.object({
    type: z.literal('compaction'),
    id: z.string().optional(),
    encrypted_content: z.string(),
  }),
  z.object({
    type: z.literal('reasoning'),
    id: z.string().optional(),
    encrypted_content: z.string().nullable().optional(),
    summary: z.array(
      z.object({ type: z.literal('summary_text'), text: z.string() }),
    ),
  }),
]);
const outputSchema = z
  .array(outputItemSchema)
  .transform(items => items.map(item => responseInputItemSchema.parse(item)));
const completionSchema = z.object({
  response: z.object({ output: outputSchema }),
});
const compactSchema = z.object({ output: outputSchema });

export function trimCompacted(items: ResponseInputItem[]): ResponseInputItem[] {
  let last = -1;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].type === 'compaction') last = index;
  }
  return last < 0 ? items : items.slice(last);
}

function dataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

type ResponsesOptions = {
  apiKey: string;
  socketUrl?: string;
  httpUrl?: string;
  fetcher?: typeof fetch;
};

export class ResponsesClient {
  constructor(private readonly options: ResponsesOptions) {}

  async compact(
    config: ResponsesModel,
    items: ResponseInputItem[],
    signal: AbortSignal,
    beforeCall: BeforePaidCall,
  ): Promise<ResponseInputItem[]> {
    await beforeCall();
    signal.throwIfAborted();
    const response = await (this.options.fetcher ?? fetch)(
      this.options.httpUrl ?? 'https://api.openai.com/v1/responses/compact',
      {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: config.id, input: items }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderFailure(
        `Context compaction failed (HTTP ${response.status}).`,
      );
    }
    const result = decodeJson(compactSchema, await response.text()).output;
    if (!result.some(item => item.type === 'compaction'))
      throw new ProviderFailure(
        'The provider did not return a compacted context.',
      );
    // The standalone compact endpoint returns the entire replacement window.
    return result;
  }

  async generate(
    config: ResponsesModel,
    input: ResponseInputItem[],
    signal: AbortSignal,
    beforeCall: BeforePaidCall,
    onChunk: (chunk: ProviderChunk) => Promise<void>,
  ): Promise<ResponseInputItem[]> {
    await beforeCall();
    signal.throwIfAborted();
    const socket = new WebSocket(
      this.options.socketUrl ?? 'wss://api.openai.com/v1/responses',
      {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        maxPayload: 32 * 1024 * 1024,
      },
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      let visible = '';
      let pending = Promise.resolve();
      const finish = (output: ResponseInputItem[] | null, error?: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        socket.terminate();
        if (error || !output)
          reject(
            error ??
              new ProviderFailure('The provider connection ended.', true),
          );
        else resolve(output);
      };
      const abort = () =>
        finish(
          null,
          new ProviderFailure('The provider request was interrupted.', true),
        );
      signal.addEventListener('abort', abort, { once: true });
      socket.on('open', () => {
        if (signal.aborted) {
          abort();
          return;
        }
        socket.send(
          JSON.stringify({
            type: 'response.create',
            model: config.id,
            input,
            store: false,
            max_output_tokens: config.maxOutput,
            include: ['reasoning.encrypted_content'],
            reasoning: { summary: 'auto' },
            context_management: [
              {
                type: 'compaction',
                compact_threshold: config.compactThreshold,
              },
            ],
          }),
        );
      });
      socket.on('message', (data: RawData) => {
        const raw = dataText(data);
        pending = pending
          .then(async () => {
            if (settled) return;
            const event = parseResponsesEvent(raw);
            if (event.kind === 'error')
              throw new ProviderFailure(event.message);
            const text = event.kind === 'delta' ? event.text : undefined;
            const reasoning =
              event.kind === 'reasoning' ? event.text : undefined;
            if (text) visible += text;
            if (event.kind !== 'ignored')
              await onChunk({ wire: 'responses', raw, text, reasoning });
            if (event.kind === 'completed') {
              const output = decodeJson(completionSchema, raw).response.output;
              if (!visible.trim())
                throw new ProviderFailure(
                  'The provider returned no visible answer.',
                );
              finish(trimCompacted([...input, ...output]));
            }
          })
          .catch(error =>
            finish(
              null,
              error instanceof ProviderFailure
                ? error
                : new ProviderFailure(
                    'The provider sent an invalid response.',
                    true,
                  ),
            ),
          );
      });
      socket.on('error', () =>
        finish(
          null,
          new ProviderFailure(
            'The provider connection failed. Retry creates a new answer.',
            true,
          ),
        ),
      );
      socket.on('close', () => {
        void pending.then(() => finish(null));
      });
    });
  }
}
