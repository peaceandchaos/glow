import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { makeCheckpoint } from '../src/compaction/context';
import type { Database } from '../src/database';
import { JobRepository, staleAfterMs } from '../src/jobs';
import { testDatabase } from './database';
import { submission } from './fixtures';

jest.setTimeout(30_000);
const owner = 'a'.repeat(64);
let postgres: PGlite;
let database: Database;
let jobs: JobRepository;
let now: number;
let dispatchCount: number;

async function dispatch(): Promise<string> {
  dispatchCount += 1;
  return `run_${dispatchCount}`;
}

beforeAll(async () => {
  ({ postgres, database } = await testDatabase());
});

beforeEach(async () => {
  await postgres.exec('TRUNCATE chat_job_events, chat_jobs, deleted_chats');
  now = 1_000;
  dispatchCount = 0;
  jobs = new JobRepository(database, () => now);
});
afterAll(async () => postgres.close());

test('a lost acceptance response recovers the same job without dispatching again', async () => {
  const input = submission();
  const first = await jobs.submit(owner, input, dispatch);
  const second = await jobs.submit(owner, input, dispatch);
  expect(first.snapshot.attemptId).toBe(second.snapshot.attemptId);
  expect(second.runId).toBe('run_1');
  expect(dispatchCount).toBe(1);
});

test('a changed request cannot reuse a reply id', async () => {
  const input = submission();
  await jobs.submit(owner, input, dispatch);
  input.history[0].text = 'Changed';
  await expect(jobs.submit(owner, input, dispatch)).rejects.toMatchObject({
    status: 409,
  });
  expect(dispatchCount).toBe(1);
});

test('dispatch failure does not acknowledge or retain an accepted job', async () => {
  const input = submission();
  await expect(
    jobs.submit(owner, input, async () => {
      throw new Error('Dispatch failed');
    }),
  ).rejects.toThrow('Dispatch failed');
  await expect(jobs.get(owner, input.attemptId)).rejects.toMatchObject({
    status: 404,
  });
});

test('duplicate worker delivery can claim paid work only once', async () => {
  const input = submission();
  await jobs.submit(owner, input, dispatch);
  const claims = await Promise.all([
    jobs.claim(owner, input.attemptId, 'run_1', 'claim_a'),
    jobs.claim(owner, input.attemptId, 'run_2', 'claim_b'),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
});

test('parallel chats are independent while a busy path rejects another send', async () => {
  const first = submission();
  const second = submission();
  await jobs.submit(owner, first, dispatch);
  await jobs.submit(owner, second, dispatch);
  await expect(
    jobs.submit(owner, { ...first, attemptId: randomUUID() }, dispatch),
  ).rejects.toMatchObject({ status: 409 });
  expect(dispatchCount).toBe(2);
});

test('completion remains retrievable after a reader closes and until durable receipt', async () => {
  const input = submission();
  await jobs.submit(owner, input, dispatch);
  await jobs.claim(owner, input.attemptId, 'run_1', 'claim');
  const checkpoint = makeCheckpoint('gpt-6.1-sol', input.userTurnId, [
    { type: 'compaction', encrypted_content: 'opaque' },
  ]);
  await jobs.update(owner, input.attemptId, 'claim', {
    actualModel: 'gpt-6.1-sol',
    status: 'generating',
    checkpoint,
  });
  const cursor = (await jobs.get(owner, input.attemptId)).snapshot.sequence;
  await jobs.update(owner, input.attemptId, 'claim', {
    text: 'The original answer.',
    status: 'completed',
  });
  const reopened = new JobRepository(database);
  const final = (await reopened.get(owner, input.attemptId)).snapshot;
  expect(final.text).toBe('The original answer.');
  expect(final.actualModel).toBe('gpt-6.1-sol');
  expect(final.checkpoint).toEqual(checkpoint);
  const { events: replay } = await reopened.poll(
    owner,
    input.attemptId,
    cursor,
    staleAfterMs,
  );
  expect(replay).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'snapshot',
        sequence: final.sequence,
        snapshot: expect.objectContaining({
          status: 'completed',
          text: 'The original answer.',
          checkpoint,
        }),
      }),
    ]),
  );
  expect(replay.every(event => event.sequence > cursor)).toBe(true);
  await expect(
    jobs.acknowledge(owner, input.attemptId, cursor),
  ).rejects.toMatchObject({ status: 409 });
  await reopened.acknowledge(owner, input.attemptId, final.sequence);
  expect((await reopened.get(owner, input.attemptId)).snapshot).toMatchObject({
    delivered: true,
    text: '',
    checkpoint: null,
  });
  await expect(reopened.input(owner, input.attemptId)).rejects.toMatchObject({
    status: 404,
  });
  expect(
    (await reopened.poll(owner, input.attemptId, 0, staleAfterMs)).events,
  ).toEqual([]);
  await reopened.submit(owner, input, dispatch);
  expect(dispatchCount).toBe(1);
});

test('a cancellation reaches another repository instance and rejects late output', async () => {
  const input = submission();
  await jobs.submit(owner, input, dispatch);
  await jobs.claim(owner, input.attemptId, 'run_1', 'claim');
  await jobs.update(owner, input.attemptId, 'claim', { text: 'Partial' });
  const otherInstance = new JobRepository(database);
  await otherInstance.requestCancellation(owner, input.attemptId);
  expect(await jobs.heartbeat(owner, input.attemptId, 'claim')).toBe(false);
  await expect(
    jobs.update(owner, input.attemptId, 'claim', { text: ' late' }),
  ).rejects.toThrow('stopped');
  expect((await jobs.get(owner, input.attemptId)).snapshot.text).toBe(
    'Partial',
  );
});

test('deletion leaves a tombstone and stops late jobs from recreating the chat', async () => {
  const input = submission();
  await jobs.submit(owner, input, dispatch);
  await jobs.claim(owner, input.attemptId, 'run_1', 'claim');
  await jobs.update(owner, input.attemptId, 'claim', {
    text: 'Private partial',
    checkpoint: makeCheckpoint('kimi', input.userTurnId, []),
  });
  await jobs.deleteChat(owner, input.chatId);
  await expect(
    jobs.submit(owner, { ...input, attemptId: randomUUID() }, dispatch),
  ).rejects.toMatchObject({ status: 410 });
  await expect(
    jobs.update(owner, input.attemptId, 'claim', { text: 'late' }),
  ).rejects.toThrow('stopped');
  expect((await jobs.get(owner, input.attemptId)).snapshot).toMatchObject({
    status: 'deleted',
    text: '',
    checkpoint: null,
  });
  expect(
    (await jobs.poll(owner, input.attemptId, 0, staleAfterMs)).events,
  ).toEqual([]);
  await expect(jobs.input(owner, input.attemptId)).rejects.toMatchObject({
    status: 404,
  });
});

test('an abandoned worker is interrupted without dispatching another generation', async () => {
  const input = submission();
  await jobs.submit(owner, input, dispatch);
  await jobs.claim(owner, input.attemptId, 'run_1', 'claim');
  await jobs.markProviderStarted(owner, input.attemptId, 'claim');
  now += 500_000;
  const result = await jobs.reconcile(owner, input.attemptId, 300_000);
  expect(result.snapshot.status).toBe('interrupted');
  expect(result.snapshot.error).toContain('before it could confirm');
  await jobs.submit(owner, input, dispatch);
  expect(dispatchCount).toBe(1);
});
