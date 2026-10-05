import type { ModelKey, Submission } from '../../../shared/contracts';
import { makeCheckpoint, prepareContext, textItem } from './compaction/context';
import type { GatewayClient } from './gateway';
import type { JevClient } from './jev';
import { models } from './models';
import type {
  BeforePaidCall,
  PreparedContext,
  ProviderChunk,
  ProviderCompletion,
  Providers,
} from './provider';
import type { ResponsesClient } from './responses';

export class LiveProviders implements Providers {
  constructor(
    private readonly responses: ResponsesClient,
    private readonly gateway: GatewayClient,
    private readonly jev: JevClient,
  ) {}

  select(input: Submission, signal: AbortSignal, beforeCall: BeforePaidCall) {
    return this.jev.select(input, signal, beforeCall);
  }

  prepare(
    input: Submission,
    model: ModelKey,
    signal: AbortSignal,
    beforeCall: BeforePaidCall,
  ): Promise<PreparedContext> {
    return prepareContext(input, model, signal, beforeCall, {
      compactOpenAI: (...args) => this.responses.compact(...args),
      summarize: (key, items, abort, before, maxOutput) =>
        this.gateway.generate(
          key,
          items,
          abort,
          before,
          () => Promise.resolve(),
          maxOutput,
        ),
    });
  }

  async generate(
    input: Submission,
    model: ModelKey,
    context: PreparedContext,
    signal: AbortSignal,
    onChunk: (chunk: ProviderChunk) => Promise<void>,
    beforeCall: BeforePaidCall,
  ): Promise<ProviderCompletion> {
    const config = models[model];
    if (config.wire === 'responses') {
      const items = await this.responses.generate(
        config,
        context.items,
        signal,
        beforeCall,
        onChunk,
      );
      const before = context.items.flatMap(item =>
        item.type === 'compaction' ? [item.encrypted_content] : [],
      );
      const changed = items.some(
        item =>
          item.type === 'compaction' &&
          !before.includes(item.encrypted_content),
      );
      return {
        checkpoint:
          context.checkpoint || changed
            ? makeCheckpoint(model, input.attemptId, items)
            : null,
      };
    }
    const text = await this.gateway.generate(
      model,
      context.items,
      signal,
      beforeCall,
      onChunk,
    );
    return {
      checkpoint: context.checkpoint
        ? makeCheckpoint(model, input.attemptId, [
            ...context.items,
            textItem('assistant', text),
          ])
        : null,
    };
  }
}
