import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { isTerminal } from '../../../shared/contracts';
import type { Database } from '../src/database';
import { deliverJob } from '../src/delivery';
import { JobRepository } from '../src/jobs';
import type { Providers } from '../src/provider';
import { schemaSql } from '../src/schema';
import { runAttempt } from '../src/worker';
import { submission } from '../tests/fixtures';

// Run: npm test -w packages/server -- --testMatch '<rootDir>/scripts/reply-speed.bench.ts'
const roundTripMs = 15;
const chunks = 200;
const chunkGapMs = 5;
const runs = 3;
const owner = 'b'.repeat(64);

jest.setTimeout(180_000);

// PGlite has one connection, so the delay is paid after a transaction rather
// than inside it; otherwise every reader would also wait behind the worker.
function delayed(postgres: PGlite, perStatementMs: number) {
  const counter = { statements: 0 };
  const database: Database = {
    async query(sql, values) {
      counter.statements += 1;
      await delay(perStatementMs);
      return postgres.query<{ data: string }>(sql, values);
    },
    async transaction(operation) {
      let statements = 2;
      try {
        return await postgres.transaction(transaction =>
          operation({
            query(sql, values) {
              statements += 1;
              return transaction.query<{ data: string }>(sql, values);
            },
          }),
        );
      } finally {
        counter.statements += statements;
        await delay(statements * perStatementMs);
      }
    },
  };
  return { counter, database };
}

const providers: Providers = {
  select: () => Promise.resolve('deepseek'),
  prepare: () => Promise.resolve({ items: [], checkpoint: null }),
  async generate(_input, _model, _context, signal, onChunk, beforeCall) {
    await beforeCall();
    for (let index = 0; index < chunks; index += 1) {
      await delay(chunkGapMs, undefined, { signal });
      await onChunk({
        wire: 'gateway',
        raw: `{"n":${index}}`,
        text: `${index} `,
      });
    }
    return { checkpoint: null };
  },
};

async function measureReply(postgres: PGlite) {
  const setup = new JobRepository(delayed(postgres, 0).database);
  const worker = delayed(postgres, roundTripMs);
  const reader = delayed(postgres, roundTripMs);
  const input = submission();
  await setup.submit(owner, input, () => Promise.resolve('run'));

  const started = performance.now();
  let firstText = Number.NaN;
  let delivered = '';
  const reading = deliverJob(
    new JobRepository(reader.database),
    owner,
    input.attemptId,
    new AbortController().signal,
    message => {
      if (message.kind !== 'event') return Promise.resolve();
      const { event } = message;
      if (event.kind === 'provider' && Number.isNaN(firstText))
        firstText = performance.now() - started;
      if (event.kind === 'snapshot' && isTerminal(event.snapshot.status))
        delivered = event.snapshot.text;
      return Promise.resolve();
    },
  );
  const jobs = new JobRepository(worker.database);
  await jobs.get(owner, input.attemptId);
  await runAttempt({
    jobs,
    providers,
    owner,
    attemptId: input.attemptId,
    runId: 'run',
    claimId: 'claim',
    publish: () => Promise.resolve(),
  });
  const workerMs = performance.now() - started;
  await reading;
  const expected = Array.from({ length: chunks }, (_, index) => `${index} `);
  expect(delivered).toBe(expected.join(''));
  return {
    workerStatements: worker.counter.statements,
    readerStatements: reader.counter.statements,
    firstTextMs: Math.round(firstText),
    workerMs: Math.round(workerMs),
    deliveredMs: Math.round(performance.now() - started),
  };
}

test('reply speed against a delayed database', async () => {
  const postgres = new PGlite();
  await postgres.exec(schemaSql);
  const installStarted = performance.now();
  await postgres.transaction(async transaction => {
    await transaction.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'personal-chat/schema-v1',
    ]);
    await transaction.exec(schemaSql);
  });
  await delay(4 * roundTripMs);
  const schemaInstall = {
    statements: 4,
    ms: Math.round(performance.now() - installStarted),
  };
  const replies = [];
  for (let run = 0; run < runs; run += 1)
    replies.push(await measureReply(postgres));
  await postgres.close();
  process.stdout.write(
    `${JSON.stringify({ roundTripMs, chunks, chunkGapMs, schemaInstall, replies })}\n`,
  );
});
