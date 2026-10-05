import {
  isTerminal,
  type JobEvent,
  type ModelKey,
} from '../../../shared/contracts';
import { AttemptCancelled, ProviderFailure } from './errors';
import type { JobRepository } from './jobs';
import type { Providers } from './provider';

type WorkerOptions = {
  jobs: JobRepository;
  providers: Providers;
  owner: string;
  attemptId: string;
  runId: string;
  claimId: string;
  publish: (events: JobEvent[]) => Promise<void>;
  heartbeatMs?: number;
  timeoutMs?: number;
};

export async function runAttempt(options: WorkerOptions): Promise<void> {
  const { jobs, providers, owner, attemptId, runId, claimId, publish } =
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

  try {
    const input = await jobs.input(owner, attemptId);
    let model: ModelKey;
    if (input.retryModel) model = input.retryModel;
    else if (input.picker === 'auto') {
      await publish(
        await jobs.update(owner, attemptId, claimId, { status: 'selecting' }),
      );
      model = await providers.select(input, controller.signal, beforeCall);
    } else model = input.picker;
    // This write checks Stop again before compaction or generation can start.
    await publish(
      await jobs.update(owner, attemptId, claimId, {
        actualModel: model,
        status: 'compacting',
      }),
    );
    const context = await providers.prepare(
      input,
      model,
      controller.signal,
      beforeCall,
    );
    const contextUpdate = context.checkpoint
      ? { checkpoint: context.checkpoint }
      : {};
    await publish(
      await jobs.update(owner, attemptId, claimId, {
        ...contextUpdate,
        status: 'generating',
      }),
    );
    const result = await providers.generate(
      input,
      model,
      context,
      controller.signal,
      async chunk =>
        publish(
          await jobs.update(owner, attemptId, claimId, {
            text: chunk.text,
            reasoning: chunk.reasoning,
            events: [{ kind: 'provider', wire: chunk.wire, raw: chunk.raw }],
          }),
        ),
      beforeCall,
    );
    controller.signal.throwIfAborted();
    const resultUpdate = result.checkpoint
      ? { checkpoint: result.checkpoint }
      : {};
    await publish(
      await jobs.update(owner, attemptId, claimId, {
        ...resultUpdate,
        status: 'completed',
      }),
    );
  } catch (error) {
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
    await publish(
      await jobs.update(owner, attemptId, claimId, {
        status: interrupted ? 'interrupted' : 'failed',
        error: message,
      }),
    );
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    controller.abort();
  }
}
