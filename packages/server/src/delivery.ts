import { setTimeout as delay } from 'node:timers/promises';
import { isTerminal, type ServerMessage } from '../../../shared/contracts';
import { staleAfterMs, type JobRepository } from './jobs';

// The SQL cursor survives Workflow's stream-retention window. Each reader owns
// only its polling signal; detaching it never cancels an accepted job.
export async function deliverJob(
  jobs: JobRepository,
  owner: string,
  attemptId: string,
  signal: AbortSignal,
  emit: (message: ServerMessage) => Promise<void>,
  intervalMs = 40,
): Promise<void> {
  const job = await jobs.reconcile(owner, attemptId, staleAfterMs);
  await emit({ kind: 'accepted', snapshot: job.snapshot });
  let sequence = job.snapshot.sequence;
  if (isTerminal(job.snapshot.status)) return;
  const started = Date.now();
  while (!signal.aborted && Date.now() - started < 250_000) {
    const { events, endedOrStale } = await jobs.poll(
      owner,
      attemptId,
      sequence,
      staleAfterMs,
    );
    for (const event of events) {
      if (signal.aborted) return;
      await emit({ kind: 'event', event });
      sequence = event.sequence;
      if (event.kind === 'snapshot' && isTerminal(event.snapshot.status))
        return;
    }
    if (events.length > 0) continue;
    if (endedOrStale) {
      const current = await jobs.reconcile(owner, attemptId, staleAfterMs);
      if (isTerminal(current.snapshot.status)) {
        await emit({ kind: 'accepted', snapshot: current.snapshot });
        return;
      }
    }
    await delay(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}

export function jobStream(
  jobs: JobRepository,
  owner: string,
  attemptId: string,
  signal: AbortSignal,
): Response {
  const readerAbort = new AbortController();
  const abort = () => readerAbort.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void deliverJob(jobs, owner, attemptId, readerAbort.signal, message => {
        if (!readerAbort.signal.aborted)
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(message)}\n\n`),
          );
        return Promise.resolve();
      })
        .catch(() => {
          if (!readerAbort.signal.aborted)
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ kind: 'error', attemptId, message: 'Delivery was interrupted. Reconnect to recover this reply.' })}\n\n`,
              ),
            );
        })
        .finally(() => {
          signal.removeEventListener('abort', abort);
          if (!readerAbort.signal.aborted) controller.close();
        });
    },
    cancel() {
      readerAbort.abort();
      signal.removeEventListener('abort', abort);
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
