import { randomBytes } from 'node:crypto';
import {
  decodeJson,
  serverMessageSchema,
  submissionCommands,
  type ServerMessage,
} from '../../../shared/contracts';
import { SseDecoder } from '../../../shared/provider-events';
import { handleRequest, type ApiServices } from '../src/api';
import { deliverJob } from '../src/delivery';
import { deviceOwner } from '../src/auth';
import { InputParts } from '../src/input-parts';
import { JobRepository, staleAfterMs } from '../src/jobs';
import { testDatabase } from './database';
import { submission } from './fixtures';

const device = randomBytes(32).toString('base64url');
const anotherDevice = randomBytes(32).toString('base64url');
const headers = { 'Content-Type': 'application/json', 'X-Device-Id': device };
const owner = deviceOwner(new Headers(headers), device);

function request(
  path: string,
  method = 'GET',
  body?: string,
  id = device,
): Request {
  return new Request(`https://fixture.example/v1/${path}`, {
    method,
    headers: { ...headers, 'X-Device-Id': id },
    body,
  });
}

async function fixture() {
  const { database, postgres } = await testDatabase();
  const jobs = new JobRepository(database);
  const dispatch = jest.fn(() => Promise.resolve('fixture-workflow'));
  const rank = jest.fn(() => Promise.resolve([]));
  const services: ApiServices = {
    allowlist: `${device},${anotherDevice}`,
    jobs: () => Promise.resolve(jobs),
    dispatch,
    rank,
  };
  return { jobs, postgres, services, dispatch, rank };
}

test('unauthorized requests are rejected before body decoding, database access, or evaluation', async () => {
  const jobs = jest.fn(() =>
    Promise.reject(new Error('Must not load database')),
  );
  const dispatch = jest.fn(() => Promise.resolve('never'));
  const rank = jest.fn(() => Promise.resolve([]));
  const services: ApiServices = { allowlist: device, jobs, dispatch, rank };
  const response = await handleRequest(
    request('chat', 'POST', 'invalid JSON', 'unknown'),
    services,
  );
  expect(response.status).toBe(401);
  expect(jobs).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(rank).not.toHaveBeenCalled();
});

test('a body that is not UTF-8 is a client error, not a server failure', async () => {
  const jobs = jest.fn(() =>
    Promise.reject(new Error('Must not load database')),
  );
  const response = await handleRequest(
    new Request('https://fixture.example/v1/chat', {
      method: 'POST',
      headers,
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    }),
    { allowlist: device, jobs, dispatch: jest.fn(), rank: jest.fn() },
  );
  expect(response.status).toBe(400);
  expect(jobs).not.toHaveBeenCalled();
});

test('contract errors and foreign-device reads return errors without reaching a provider', async () => {
  const f = await fixture();
  try {
    const input = submission();
    const invalid = await handleRequest(
      request(
        'chat',
        'POST',
        JSON.stringify({
          kind: 'submit',
          submission: { ...input, version: 99 },
        }),
      ),
      f.services,
    );
    expect(invalid.status).toBe(400);
    expect(f.dispatch).not.toHaveBeenCalled();
    await f.jobs.submit(owner, input, f.dispatch);
    for (const [method, suffix] of [
      ['GET', ''],
      ['GET', '/events'],
      ['POST', '/stop'],
      ['POST', '/ack'],
    ]) {
      const result = await handleRequest(
        request(
          `jobs/${input.attemptId}${suffix}`,
          method,
          method === 'POST' ? '{"sequence":0}' : undefined,
          anotherDevice,
        ),
        f.services,
      );
      expect(result.status).toBe(suffix === '/stop' ? 204 : 404);
    }
    expect(
      (await f.jobs.get(owner, input.attemptId)).snapshot.cancelRequested,
    ).toBe(false);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  } finally {
    await f.postgres.close();
  }
});

test('Stop before acceptance leaves a tombstone that blocks the late handoff', async () => {
  const f = await fixture();
  try {
    const input = submission();
    const stopped = await handleRequest(
      request(`jobs/${input.attemptId}/stop`, 'POST'),
      f.services,
    );
    expect(stopped.status).toBe(204);
    const submitted = await handleRequest(
      request(
        'chat',
        'POST',
        JSON.stringify({ kind: 'submit', submission: input }),
      ),
      f.services,
    );
    expect(submitted.status).toBe(410);
    expect(f.dispatch).not.toHaveBeenCalled();
  } finally {
    await f.postgres.close();
  }
});

test('closing a POST reader preserves its accepted job and later completion', async () => {
  const f = await fixture();
  try {
    const input = submission();
    const response = await handleRequest(
      request(
        'chat',
        'POST',
        JSON.stringify({ kind: 'submit', submission: input }),
      ),
      f.services,
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing SSE fixture body');
    const first = await reader.read();
    const parser = new SseDecoder();
    const accepted: ServerMessage[] = parser
      .push(new TextDecoder().decode(first.value))
      .map(raw => decodeJson(serverMessageSchema, raw));
    expect(accepted[0].kind).toBe('accepted');
    await reader.cancel();
    expect(
      (await f.jobs.get(owner, input.attemptId)).snapshot.cancelRequested,
    ).toBe(false);
    await f.jobs.claim(owner, input.attemptId, 'fixture-workflow', 'one-claim');
    await f.jobs.update(owner, input.attemptId, 'one-claim', {
      text: 'Completed while the reader was gone.',
      status: 'completed',
      actualModel: 'kimi',
    });
    const recovered = await handleRequest(
      request(`jobs/${input.attemptId}`),
      f.services,
    );
    expect(await recovered.text()).toContain(
      'Completed while the reader was gone.',
    );
    const duplicate = await handleRequest(
      request(
        'chat',
        'POST',
        JSON.stringify({ kind: 'submit', submission: input }),
      ),
      f.services,
    );
    await duplicate.body?.cancel();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  } finally {
    await f.postgres.close();
  }
});

test('multipart input is idempotent and cannot launch until every part is saved', async () => {
  const f = await fixture();
  try {
    const input = submission();
    input.history[0].text = '你好 🦋 "'.repeat(100_000);
    const commands = [...submissionCommands(input)];
    const parts = new InputParts(f.jobs);
    const last = commands.at(-1);
    const first = commands[0];
    if (last?.kind !== 'commit' || first.kind !== 'stage')
      throw new Error('Expected staged fixture');
    await parts.stage(owner, first);
    await parts.stage(owner, first);
    await expect(parts.commit(owner, last, f.dispatch)).rejects.toThrow(
      'all context parts',
    );
    expect(f.dispatch).not.toHaveBeenCalled();
    for (const command of commands.slice(1, -1)) {
      if (command.kind !== 'stage') throw new Error('Expected context part');
      expect(Buffer.byteLength(JSON.stringify(command))).toBeLessThan(
        4_000_000,
      );
      await parts.stage(owner, command);
    }
    await parts.commit(owner, last, f.dispatch);
    await parts.commit(owner, last, f.dispatch);
    expect(await f.jobs.input(owner, input.attemptId)).toEqual(input);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  } finally {
    await f.postgres.close();
  }
});

test('Delete rejects later context parts and prevents them from recreating a chat', async () => {
  const f = await fixture();
  try {
    const input = submission();
    input.history[0].text = 'long text'.repeat(40_000);
    const first = [...submissionCommands(input)][0];
    if (first.kind !== 'stage') throw new Error('Expected staged fixture');
    const parts = new InputParts(f.jobs);
    await parts.stage(owner, first);
    const deleted = await handleRequest(
      request(`chats/${input.chatId}`, 'DELETE'),
      f.services,
    );
    expect(deleted.status).toBe(204);
    await expect(parts.stage(owner, first)).rejects.toThrow('deleted');
    expect(f.dispatch).not.toHaveBeenCalled();
  } finally {
    await f.postgres.close();
  }
});

// With 150 ms between polls, the app committed reply text every 150 ms instead
// of main's 50 ms (ui-evidence/ab-pr1).
test('an attached reader checks a running job for new text every 40 ms', async () => {
  const f = await fixture();
  try {
    const job = submission();
    await f.jobs.submit(owner, job, f.dispatch);
    const reader = new AbortController();
    const waits: number[] = [];
    let lastPollEnd: number | null = null;
    const poll = f.jobs.poll.bind(f.jobs);
    jest.spyOn(f.jobs, 'poll').mockImplementation(async (...args) => {
      if (lastPollEnd !== null) waits.push(performance.now() - lastPollEnd);
      if (waits.length === 9) reader.abort();
      const result = await poll(...args);
      lastPollEnd = performance.now();
      return result;
    });
    await deliverJob(f.jobs, owner, job.attemptId, reader.signal, () =>
      Promise.resolve(),
    );
    // Machine load only lengthens a wait, so the shortest one is the
    // requested interval.
    const shortest = Math.min(...waits);
    expect(shortest).toBeGreaterThanOrEqual(38);
    expect(shortest).toBeLessThan(100);
  } finally {
    await f.postgres.close();
  }
}, 30_000);

test('an attached reader ends with the final snapshot when the job ends without an event', async () => {
  const f = await fixture();
  try {
    let now = 1_000;
    const jobs = new JobRepository(f.jobs.database, () => now);
    const messages = async (
      attemptId: string,
      end: () => Promise<void>,
    ): Promise<ServerMessage[]> => {
      const received: ServerMessage[] = [];
      let ended = false;
      await deliverJob(
        jobs,
        owner,
        attemptId,
        new AbortController().signal,
        async message => {
          received.push(message);
          if (!ended) {
            ended = true;
            await end();
          }
        },
        1,
      );
      return received;
    };
    const deleted = submission();
    await jobs.submit(owner, deleted, f.dispatch);
    const afterDelete = await messages(deleted.attemptId, () =>
      jobs.deleteChat(owner, deleted.chatId),
    );
    expect(afterDelete.map(message => message.kind)).toEqual([
      'accepted',
      'accepted',
    ]);
    expect(afterDelete[1]).toMatchObject({
      snapshot: { status: 'deleted' },
    });
    const abandoned = submission();
    await jobs.submit(owner, abandoned, f.dispatch);
    const afterStale = await messages(abandoned.attemptId, async () => {
      now += staleAfterMs + 1;
    });
    expect(afterStale.at(-1)).toMatchObject({
      snapshot: { status: 'interrupted' },
    });
  } finally {
    await f.postgres.close();
  }
});
