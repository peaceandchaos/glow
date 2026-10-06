import { setImmediate as tick } from 'node:timers/promises';
import type { PGlite } from '@electric-sql/pglite';
import { bakedCatalog, type Catalog } from '../../../shared/catalog';
import type { Database } from '../src/database';
import { JobRepository, staleAfterMs } from '../src/jobs';
import { ProviderFailure } from '../src/errors';
import type { Providers } from '../src/provider';
import { runAttempt } from '../src/worker';
import { testDatabase } from './database';
import { submission } from './fixtures';

jest.setTimeout(30_000);
const owner = 'c'.repeat(64);
let postgres: PGlite;
let database: Database;
let jobs: JobRepository;
let selectionCalls: number;
let generationCalls: number;
let providers: Providers;
let selection: string;
let offers: (readonly string[])[];
let generated: { model: string; effort: string | null }[];

beforeAll(async () => {
  const fixture = await testDatabase();
  postgres = fixture.postgres;
  database = fixture.database;
  jobs = new JobRepository(database);
});
beforeEach(async () => {
  await postgres.exec('TRUNCATE chat_job_events, chat_jobs, deleted_chats');
  selectionCalls = 0;
  generationCalls = 0;
  selection = 'deepseek';
  offers = [];
  generated = [];
  providers = {
    async select(_input, _signal, beforeCall, offered) {
      await beforeCall();
      selectionCalls += 1;
      offers.push(offered);
      return selection;
    },
    async prepare() {
      return { items: [], checkpoint: null };
    },
    async generate(
      _input,
      model,
      _context,
      _signal,
      onChunk,
      beforeCall,
      effort,
    ) {
      await beforeCall();
      generationCalls += 1;
      generated.push({ model, effort });
      await onChunk({ wire: 'gateway', raw: 'fixture', text: 'Saved answer' });
      return { checkpoint: null };
    },
  };
});
afterAll(async () => postgres.close());

async function execute(
  attemptId: string,
  catalog: Catalog = bakedCatalog,
): Promise<void> {
  return runAttempt({
    jobs,
    providers,
    catalog,
    owner,
    attemptId,
    runId: 'run',
    claimId: 'claim',
    heartbeatMs: 5,
    timeoutMs: 5_000,
  });
}

test('one Auto submission evaluates once and saves the selected model before tokens', async () => {
  const input = submission();
  await jobs.submit(owner, input, async () => 'run');
  await execute(input.attemptId);
  expect(selectionCalls).toBe(1);
  expect(generationCalls).toBe(1);
  const { events } = await jobs.poll(owner, input.attemptId, 0, staleAfterMs);
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

async function storedEvents(attemptId: string) {
  return (await jobs.poll(owner, attemptId, 0, staleAfterMs)).events;
}

async function untilSaved(attemptId: string, text: string): Promise<void> {
  while ((await jobs.get(owner, attemptId)).snapshot.text !== text)
    await tick();
}

test.each([
  ['completed', 'completes'],
  ['interrupted', 'disconnects'],
] as const)(
  'chunks that arrive during a slow write all reach the %s reply in order',
  async (status, ending) => {
    const input = { ...submission(), picker: 'deepseek' as const };
    await jobs.submit(owner, input, async () => 'run');
    const parts = Array.from({ length: 50 }, (_, index) => `${index} `);
    let transactions = 0;
    let held: Promise<void> | null = null;
    const slow: Database = {
      query: (sql, values) => database.query(sql, values),
      async transaction(operation) {
        transactions += 1;
        const wait = held;
        held = null;
        await wait;
        return database.transaction(operation);
      },
    };
    let streamStart = 0;
    providers.generate = async (_input, _model, _context, _signal, emit) => {
      let release = () => {};
      held = new Promise<void>(resolve => {
        release = resolve;
      });
      streamStart = transactions;
      for (const [index, text] of parts.entries())
        await emit({ wire: 'gateway', raw: `{"n":${index}}`, text });
      release();
      if (ending === 'disconnects')
        throw new ProviderFailure(
          'The provider connection was interrupted.',
          true,
        );
      return { checkpoint: null };
    };
    await runAttempt({
      jobs: new JobRepository(slow),
      providers,
      catalog: bakedCatalog,
      owner,
      attemptId: input.attemptId,
      runId: 'run',
      claimId: 'claim',
      heartbeatMs: 60_000,
      timeoutMs: 5_000,
    });
    expect(transactions - streamStart).toBe(2);
    expect((await jobs.get(owner, input.attemptId)).snapshot).toMatchObject({
      status,
      text: parts.join(''),
    });
    const events = await storedEvents(input.attemptId);
    expect(events.map(event => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(
      events.flatMap(event => (event.kind === 'provider' ? [event.raw] : [])),
    ).toEqual(parts.map((_, index) => `{"n":${index}}`));
  },
);

test('Stop mid-stream keeps the saved text and accepts nothing after it', async () => {
  const input = { ...submission(), picker: 'deepseek' as const };
  await jobs.submit(owner, input, async () => 'run');
  providers.generate = async (_input, _model, _context, _signal, emit) => {
    await emit({ wire: 'gateway', raw: 'kept', text: 'Kept ' });
    await untilSaved(input.attemptId, 'Kept ');
    await jobs.requestCancellation(owner, input.attemptId);
    for (let index = 0; index < 100; index += 1) {
      await emit({ wire: 'gateway', raw: 'late', text: 'Late ' });
      await tick();
    }
    return { checkpoint: null };
  };
  await execute(input.attemptId);
  expect((await jobs.get(owner, input.attemptId)).snapshot).toMatchObject({
    status: 'stopped',
    text: 'Kept ',
  });
  const events = await storedEvents(input.attemptId);
  expect(events.at(-1)).toMatchObject({
    kind: 'snapshot',
    snapshot: { status: 'stopped', text: 'Kept ' },
  });
  expect(
    events.some(event => event.kind === 'provider' && event.raw === 'late'),
  ).toBe(false);
});

test('a worker lost mid-stream and a retry converge on one interrupted reply', async () => {
  const input = { ...submission(), picker: 'deepseek' as const };
  await jobs.submit(owner, input, async () => 'run');
  providers.generate = async (_input, _model, _context, signal, emit) => {
    generationCalls += 1;
    await emit({ wire: 'gateway', raw: 'saved', text: 'Saved ' });
    await untilSaved(input.attemptId, 'Saved ');
    await new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      }),
    );
    return { checkpoint: null };
  };
  const lost = execute(input.attemptId);
  await untilSaved(input.attemptId, 'Saved ');
  await runAttempt({
    jobs,
    providers,
    catalog: bakedCatalog,
    owner,
    attemptId: input.attemptId,
    runId: 'retry',
    claimId: 'retry',
    heartbeatMs: 5,
    timeoutMs: 5_000,
  });
  const later = new JobRepository(
    database,
    () => Date.now() + staleAfterMs + 1,
  );
  const first = await later.reconcile(owner, input.attemptId, staleAfterMs);
  await lost;
  const second = await later.reconcile(owner, input.attemptId, staleAfterMs);
  expect(generationCalls).toBe(1);
  expect(first.snapshot).toMatchObject({
    status: 'interrupted',
    text: 'Saved ',
  });
  expect(second.snapshot).toEqual(first.snapshot);
  const events = await storedEvents(input.attemptId);
  expect(events.map(event => event.sequence)).toEqual(
    events.map((_, index) => index + 1),
  );
});

test('a stored level reaches the provider, and no level runs the model default', async () => {
  for (const choice of [
    { picker: 'gpt-6.1-sol', level: 'high' },
    { picker: 'gpt-6.1-sol' },
    { picker: 'deepseek' },
    { picker: 'kimi' },
    { picker: 'kimi', level: 'max' },
  ]) {
    const input = { ...submission(), ...choice };
    await jobs.submit(owner, input, async () => 'run');
    await execute(input.attemptId);
  }
  expect(selectionCalls).toBe(0);
  expect(generated).toEqual([
    { model: 'gpt-6.1-sol', effort: 'high' },
    { model: 'gpt-6.1-sol', effort: 'low' },
    { model: 'deepseek', effort: 'none' },
    { model: 'kimi', effort: 'none' },
    { model: 'kimi', effort: 'max' },
  ]);
});

test('with Auto off, an Auto chat runs the first model without Jev', async () => {
  const input = submission();
  await jobs.submit(owner, input, async () => 'run');
  await execute(input.attemptId, { ...bakedCatalog, auto: false });
  expect(selectionCalls).toBe(0);
  expect(generated).toEqual([{ model: 'deepseek', effort: 'none' }]);
});

test('a model the menu does not offer runs the first model instead of failing', async () => {
  const input = { ...submission(), picker: 'gpt-6-luna', level: 'high' };
  await jobs.submit(owner, input, async () => 'run');
  await execute(input.attemptId);
  expect(generated).toEqual([{ model: 'deepseek', effort: 'none' }]);
  expect((await jobs.get(owner, input.attemptId)).snapshot).toMatchObject({
    status: 'completed',
    actualModel: 'deepseek',
  });
});

test('Jev chooses among the offered models, and its pick runs at its default level', async () => {
  const [, , sol, astra] = bakedCatalog.models;
  selection = 'gpt-6-astra';
  const input = { ...submission(), level: 'max' };
  await jobs.submit(owner, input, async () => 'run');
  await execute(input.attemptId, { auto: true, models: [sol, astra] });
  expect(offers).toEqual([['gpt-6.1-sol', 'gpt-6-astra']]);
  expect(generated).toEqual([{ model: 'gpt-6-astra', effort: 'low' }]);
});
