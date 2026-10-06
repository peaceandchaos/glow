import {
  isTerminal,
  type EventPayload,
  type ModelKey,
} from '../../../shared/contracts';
import { AttemptCancelled, ProviderFailure } from './errors';
import type { JobRepository } from './jobs';
import type { ProviderChunk, Providers } from './provider';

type WorkerOptions = {
  jobs: JobRepository;
  providers: Providers;
  owner: string;
  attemptId: string;
  runId: string;
  claimId: string;
  heartbeatMs?: number;
  timeoutMs?: number;
};

type ChunkBatch = { text: string; reasoning: string; events: EventPayload[] };

const emptyBatch = (): ChunkBatch => ({ text: '', reasoning: '', events: [] });

// Keeps one write in flight. Chunks that arrive during it join the next write,
// so a slow database round trip never paces the provider stream.
function chunkWriter(write: (batch: ChunkBatch) => Promise<void>) {
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
    // The terminal write carries the unwritten rest, so nothing received is lost.
    async close() {
      closed = true;
      await writing;
      return { rest: pending, failure };
    },
  };
}

export async function runAttempt(options: WorkerOptions): Promise<void> {
  const { jobs, providers, owner, attemptId, runId, claimId } = options;
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
  const chunks = chunkWriter(async batch => {
    await jobs.update(owner, attemptId, claimId, batch);
  });

  try {
    const input = await jobs.input(owner, attemptId);
    let model: ModelKey;
    if (input.retryModel) model = input.retryModel;
    else if (input.picker === 'auto') {
      await jobs.update(owner, attemptId, claimId, { status: 'selecting' });
      model = await providers.select(input, controller.signal, beforeCall);
    } else model = input.picker;
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
    );
    controller.signal.throwIfAborted();
    const { rest, failure } = await chunks.close();
    if (failure) throw failure.error;
    const resultUpdate = result.checkpoint
      ? { checkpoint: result.checkpoint }
      : {};
    await jobs.update(owner, attemptId, claimId, {
      ...rest,
      ...resultUpdate,
      status: 'completed',
    });
  } catch (error) {
    const { rest } = await chunks.close();
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
      ...rest,
      status: interrupted ? 'interrupted' : 'failed',
      error: message,
    });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    controller.abort();
  }
}
