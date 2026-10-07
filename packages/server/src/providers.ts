import { z } from 'zod';
import type { Submission } from '../../../shared/contracts';
import { makeCheckpoint, prepareContext, textItem } from './compaction/context';
import type { GatewayClient } from './gateway';
import type { JevClient } from './jev';
import {
  identityInstruction,
  models,
  type Effort,
  type RegistryKey,
} from './models';
import type {
  BeforePaidCall,
  PreparedContext,
  ProviderChunk,
  ProviderCompletion,
  Providers,
} from './provider';
import type { ResponsesClient } from './responses';

const modelReportSchema = z.object({
  model: z.string().optional(),
  response: z.object({ model: z.string().optional() }).optional(),
});

function reportedModel(raw: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const report = modelReportSchema.safeParse(data);
  return report.success
    ? (report.data.model ?? report.data.response?.model)
    : undefined;
}

export class LiveProviders implements Providers {
  constructor(
    private readonly responses: ResponsesClient,
    private readonly gateway: GatewayClient,
    private readonly jev: JevClient,
  ) {}

  select(
    input: Submission,
    signal: AbortSignal,
    beforeCall: BeforePaidCall,
    offered: readonly string[],
  ) {
    return this.jev.select(input, signal, beforeCall, offered);
  }

  prepare(
    input: Submission,
    model: RegistryKey,
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
          models[key].levels[0] ?? null,
          maxOutput,
        ),
    });
  }

  async generate(
    input: Submission,
    model: RegistryKey,
    context: PreparedContext,
    signal: AbortSignal,
    onChunk: (chunk: ProviderChunk) => Promise<void>,
    beforeCall: BeforePaidCall,
    effort: Effort | null,
  ): Promise<ProviderCompletion> {
    let answered: string | undefined;
    const completion = await this.reply(
      input,
      model,
      context,
      signal,
      chunk => {
        answered ??= reportedModel(chunk.raw);
        return onChunk(chunk);
      },
      beforeCall,
      effort,
    );
    console.info(
      `reply model attempt=${input.attemptId.slice(0, 8)} requested=${models[model].id} answered=${answered ?? '-'}`,
    );
    return completion;
  }

  private async reply(
    input: Submission,
    model: RegistryKey,
    context: PreparedContext,
    signal: AbortSignal,
    onChunk: (chunk: ProviderChunk) => Promise<void>,
    beforeCall: BeforePaidCall,
    effort: Effort | null,
  ): Promise<ProviderCompletion> {
    const config = models[model];
    if (config.wire === 'responses') {
      const items = await this.responses.generate(
        config,
        context.items,
        signal,
        beforeCall,
        onChunk,
        effort,
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
      [textItem('system', identityInstruction(config)), ...context.items],
      signal,
      beforeCall,
      onChunk,
      effort,
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
