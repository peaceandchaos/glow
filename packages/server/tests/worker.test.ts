import type { PGlite } from '@electric-sql/pglite';
import type { JobEvent } from '../../../shared/contracts';
import { JobRepository } from '../src/jobs';
import { ProviderFailure } from '../src/errors';
import type { Providers } from '../src/provider';
import { runAttempt } from '../src/worker';
import { testDatabase } from './database';
import { submission } from './fixtures';

jest.setTimeout(30_000);
const owner = 'c'.repeat(64);
let postgres: PGlite;
let jobs: JobRepository;
let selectionCalls: number;
let generationCalls: number;
let providers: Providers;
let events: JobEvent[];

beforeAll(async () => {
  const fixture = await testDatabase();
  postgres = fixture.postgres;
  jobs = new JobRepository(fixture.database);
});
beforeEach(async () => {
  await postgres.exec('TRUNCATE chat_job_events, chat_jobs, deleted_chats');
  selectionCalls = 0;
  generationCalls = 0;
  events = [];
  providers = {
    async select(_input, _signal, beforeCall) {
      await beforeCall();
      selectionCalls += 1;
      return 'deepseek';
    },
    async prepare() {
      return { items: [], checkpoint: null };
    },
    async generate(_input, _model, _context, _signal, onChunk, beforeCall) {
      await beforeCall();
      generationCalls += 1;
      await onChunk({ wire: 'gateway', raw: 'fixture', text: 'Saved answer' });
      return { checkpoint: null };
    },
  };
});
afterAll(async () => postgres.close());

async function execute(attemptId: string): Promise<void> {
  return runAttempt({
    jobs,
    providers,
    owner,
    attemptId,
    runId: 'run',
    claimId: 'claim',
    heartbeatMs: 5,
    timeoutMs: 5_000,
    async publish(batch) {
      events.push(...batch);
    },
  });
}

test('one Auto submission evaluates once and saves the selected model before tokens', async () => {
  const input = submission();
  await jobs.submit(owner, input, async () => 'run');
  await execute(input.attemptId);
  expect(selectionCalls).toBe(1);
  expect(generationCalls).toBe(1);
  const selectionIndex = events.findIndex(
    event => event.kind === 'status' && event.actualModel === 'deepseek',
  );
  const providerIndex = events.findIndex(event => event.kind === 'provider');
  expect(selectionIndex).toBeGreaterThanOrEqual(0);
  expect(providerIndex).toBeGreaterThanOrEqual(0);
  expect(selectionIndex).toBeLessThan(providerIndex);
  expect((await jobs.get(owner, input.attemptId)).snapshot).toMatchObject({
    status: 'completed',
    text: 'Saved answer',
    actualModel: 'deepseek',
  });
});

test('manual choices and known-model Retry skip Jev', async () => {
  const manual = { ...submission(), picker: 'kimi' as const };
  await jobs.submit(owner, manual, async () => 'manual');
  await execute(manual.attemptId);
  const retry = { ...submission(), retryModel: 'gpt-6.1-sol' as const };
  await jobs.submit(owner, retry, async () => 'retry');
  await execute(retry.attemptId);
  expect(selectionCalls).toBe(0);
  expect(generationCalls).toBe(2);
  expect((await jobs.get(owner, retry.attemptId)).snapshot.actualModel).toBe(
    'gpt-6.1-sol',
  );
});

test('selection failure never falls back or launches generation', async () => {
  const input = submission();
  providers.select = async () => {
    throw new ProviderFailure('Selection failed.');
  };
  await jobs.submit(owner, input, async () => 'run');
  await execute(input.attemptId);
  expect(generationCalls).toBe(0);
  expect((await jobs.get(owner, input.attemptId)).snapshot.status).toBe(
    'failed',
  );
});

test('Stop during selection cancels evaluation and prevents a later provider launch', async () => {
  const input = submission();
  let aborted = false;
  providers.select = async (_input, signal) => {
    await jobs.requestCancellation(owner, input.attemptId);
    await new Promise<void>(resolve =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    return 'gpt-6.1-sol';
  };
  await jobs.submit(owner, input, async () => 'run');
  await execute(input.attemptId);
  expect(aborted).toBe(true);
  expect(generationCalls).toBe(0);
  expect((await jobs.get(owner, input.attemptId)).snapshot.status).toBe(
    'stopped',
  );
});

test('Stop during compaction prevents generation even if compaction returns late', async () => {
  const input = submission();
  providers.prepare = async () => {
    await jobs.requestCancellation(owner, input.attemptId);
    return { items: [], checkpoint: null };
  };
  await jobs.submit(owner, input, async () => 'run');
  await execute(input.attemptId);
  expect(generationCalls).toBe(0);
  expect((await jobs.get(owner, input.attemptId)).snapshot.status).toBe(
    'stopped',
  );
});

test('an upstream disconnect retains the partial answer without another paid call', async () => {
  const input = submission();
  providers.generate = async (
    _input,
    _model,
    _context,
    _signal,
    emit,
    beforeCall,
  ) => {
    await beforeCall();
    generationCalls += 1;
    await emit({ wire: 'gateway', raw: 'fixture', text: 'Partial' });
    throw new ProviderFailure('The provider connection was interrupted.', true);
  };
  await jobs.submit(owner, input, async () => 'run');
  await execute(input.attemptId);
  await execute(input.attemptId);
  expect(generationCalls).toBe(1);
  expect((await jobs.get(owner, input.attemptId)).snapshot).toMatchObject({
    status: 'interrupted',
    text: 'Partial',
  });
});
