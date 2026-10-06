import { resolveChoice, type Catalog } from '../../../shared/catalog';
import { isTerminal, type EventPayload } from '../../../shared/contracts';
import { AttemptCancelled, ProviderFailure } from './errors';
import type { JobRepository } from './jobs';
import { effortFor, isRegistryKey } from './models';
import type { ProviderChunk, Providers } from './provider';

type WorkerOptions = {
  jobs: JobRepository;
  providers: Providers;
  catalog: Catalog;
  owner: string;
  attemptId: string;
  runId: string;
  claimId: string;
  heartbeatMs?: number;
  timeoutMs?: number;
};

type ChunkBatch = { text: string; reasoning: string; events: EventPayload[] };

const emptyBatch = (): ChunkBatch => ({ text: '', reasoning: '', events: [] });

function coalescingChunkWriter(write: (batch: ChunkBatch) => Promise<void>) {
  let pending = emptyBatch();
  let writing: Promise<void> | null = null;
  let failure: { error: unknown } | null = null;
  let closed = false;
  const drain = async () => {
    while (!closed && !failure && pending.events.length > 0) {
      const batch = pending;
      pending = emptyBatch();
      try {
        await write(batch);
      } catch (error) {
        failure = { error };
        pending = {
          text: batch.text + pending.text,
          reasoning: batch.reasoning + pending.reasoning,
          events: [...batch.events, ...pending.events],
        };
      }
    }
    writing = null;
  };
  return {
    push(chunk: ProviderChunk): void {
      if (failure) throw failure.error;
      pending.text += chunk.text ?? '';
      pending.reasoning += chunk.reasoning ?? '';
      pending.events.push({
        kind: 'provider',
        wire: chunk.wire,
        raw: chunk.raw,
      });
      writing ??= drain();
    },
    async close() {
      closed = true;
      await writing;
      return { unwritten: pending, failure };
    },
  };
}

export async function runAttempt(options: WorkerOptions): Promise<void> {
  const { jobs, providers, catalog, owner, attemptId, runId, claimId } =
    options;
  if (!(await jobs.claim(owner, attemptId, runId, claimId))) return;
  const controller = new AbortController();
  let checking = false;
  let timedOut = false;
  const heartbeat = setInterval(() => {
    if (checking) return;
    checking = true;
    void jobs
      .heartbeat(owner, attemptId, claimId)
      .then(active => {
        if (!active) controller.abort();
      })
      .catch(() => controller.abort())
      .finally(() => {
        checking = false;
      });
  }, options.heartbeatMs ?? 750);
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 270_000);
  const beforeCall = async () => {
    controller.signal.throwIfAborted();
    await jobs.markProviderStarted(owner, attemptId, claimId);
    controller.signal.throwIfAborted();
  };
  const chunks = coalescingChunkWriter(async batch => {
    await jobs.update(owner, attemptId, claimId, batch);
  });

  try {
    const input = await jobs.input(owner, attemptId);
    let choice = resolveChoice(
      catalog,
      input.retryModel ?? input.picker,
      input.level,
    );
    if (choice.kind === 'auto') {
      await jobs.update(owner, attemptId, claimId, { status: 'selecting' });
      const pick = await providers.select(
        input,
        controller.signal,
        beforeCall,
        catalog.models.map(entry => entry.key),
      );
      // Jev's pick runs at that model's default level.
      choice = resolveChoice(catalog, pick, undefined);
    }
    if (choice.kind === 'auto' || !isRegistryKey(choice.model))
      throw new ProviderFailure('This model is not available.');
    const model = choice.model;
    const effort = effortFor(model, choice.level);
    // This write checks Stop again before compaction or generation can start.
    await jobs.update(owner, attemptId, claimId, {
      actualModel: model,
      status: 'compacting',
    });
    const context = await providers.prepare(
      input,
      model,
      controller.signal,
      beforeCall,
    );
    const contextUpdate = context.checkpoint
      ? { checkpoint: context.checkpoint }
      : {};
    await jobs.update(owner, attemptId, claimId, {
      ...contextUpdate,
      status: 'generating',
    });
    const result = await providers.generate(
      input,
      model,
      context,
      controller.signal,
      async chunk => chunks.push(chunk),
      beforeCall,
      effort,
    );
    controller.signal.throwIfAborted();
    const { unwritten, failure } = await chunks.close();
    if (failure) throw failure.error;
    const resultUpdate = result.checkpoint
      ? { checkpoint: result.checkpoint }
      : {};
    await jobs.update(owner, attemptId, claimId, {
      ...unwritten,
      ...resultUpdate,
      status: 'completed',
    });
  } catch (error) {
    const { unwritten } = await chunks.close();
    const current = await jobs.get(owner, attemptId);
    if (
      isTerminal(current.snapshot.status) ||
      error instanceof AttemptCancelled
    )
      return;
    const interrupted =
      timedOut ||
      controller.signal.aborted ||
      (error instanceof ProviderFailure && error.uncertain);
    const message = timedOut
      ? 'The worker reached its time limit. The partial answer is saved. Retry creates a new answer.'
      : error instanceof ProviderFailure
        ? error.message
        : 'The reply could not finish. Retry creates a new answer.';
    await jobs.update(owner, attemptId, claimId, {
      ...unwritten,
      status: interrupted ? 'interrupted' : 'failed',
      error: message,
    });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    controller.abort();
  }
}
