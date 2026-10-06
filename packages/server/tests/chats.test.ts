import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { bakedCatalog } from '../../../shared/catalog';
import {
  decodeJson,
  searchResponseSchema,
  syncPageSchema,
  type SearchResponse,
  type Submission,
  type SyncPage,
  type SyncPush,
} from '../../../shared/contracts';
import { handleRequest, type ApiServices } from '../src/api';
import { newSessionToken } from '../src/auth';
import { ChatRows } from '../src/chats';
import type { Database } from '../src/database';
import { AttemptCancelled } from '../src/errors';
import { JobRepository, staleAfterMs } from '../src/jobs';
import { schemaSql } from '../src/schema';
import { testDatabase } from './database';
import { submission } from './fixtures';
import { signedIn } from './sessions';

jest.setTimeout(60_000);
type ChatPush = SyncPush['chats'][number];
type MessageRow = SyncPush['messages'][number];

const token = newSessionToken();
const otherToken = newSessionToken();
const owner = 'apple-user-1';
let postgres: PGlite;
let database: Database;
let services: ApiServices;
let jobs: JobRepository;
let now = 1_000;

beforeAll(async () => {
  ({ postgres, database } = await testDatabase());
  jobs = new JobRepository(database, () => now);
  services = {
    ...(await signedIn(database, [
      [token, owner],
      [otherToken, 'apple-user-2'],
    ])),
    jobs: () => Promise.resolve(jobs),
    chats: () => Promise.resolve(new ChatRows(database)),
    dispatch: () => Promise.reject(new Error('Must not dispatch')),
    catalog: bakedCatalog,
  };
});
beforeEach(async () => {
  await postgres.exec(
    `TRUNCATE chat_owners, chats, chat_messages, deleted_chats,
       chat_job_events, chat_jobs, cancelled_attempts`,
  );
});
afterAll(async () => postgres.close());

function send(path: string, method: string, body?: string, id = token) {
  return handleRequest(
    new Request(`https://fixture.example/v1/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${id}`,
      },
      body,
    }),
    services,
  );
}

async function push(batch: Partial<SyncPush>, id = token): Promise<void> {
  const response = await send(
    'sync',
    'POST',
    JSON.stringify({ chats: [], messages: [], ...batch }),
    id,
  );
  expect(response.status).toBe(204);
}

async function pull(after: number, id = token): Promise<SyncPage> {
  const response = await send(`sync?after=${after}`, 'GET', undefined, id);
  expect(response.status).toBe(200);
  return decodeJson(syncPageSchema, await response.text());
}

async function pullAll(id = token): Promise<SyncPage[]> {
  const pages: SyncPage[] = [];
  for (let after = 0, more = true; more;) {
    const page = await pull(after, id);
    pages.push(page);
    ({ cursor: after, more } = page);
  }
  return pages;
}

function chat(id: string, fields: Partial<ChatPush> = {}): ChatPush {
  return {
    id,
    title: 'First chat',
    picker: 'auto',
    basePathId: randomUUID(),
    leafId: randomUUID(),
    createdAt: 1_000,
    updatedAt: 1_000,
    dirty: ['title', 'model', 'leaf'],
    ...fields,
  };
}

function message(chatId: string, text = 'Hello'): MessageRow {
  return {
    id: randomUUID(),
    chatId,
    parentId: null,
    pathId: randomUUID(),
    role: 'user',
    status: 'completed',
    text,
    reasoning: '',
    imageCount: 0,
    picker: 'auto',
    retryModel: null,
    actualModel: null,
    error: null,
    createdAt: 1_000,
  };
}

async function storedRows(chatId: string): Promise<number> {
  const result = await postgres.query<{ n: number }>(
    `SELECT ((SELECT count(*) FROM chats WHERE id = $1)
      + (SELECT count(*) FROM chat_messages WHERE chat_id = $1))::int AS n`,
    [chatId],
  );
  return result.rows[0].n;
}

test('the schema installs twice over pre-sync tombstones, which are never pulled or pushed into', async () => {
  const legacy = await testDatabase(
    `CREATE TABLE deleted_chats (owner text NOT NULL, chat_id uuid NOT NULL,
       PRIMARY KEY (owner, chat_id));
     INSERT INTO deleted_chats VALUES ('${owner}', '${randomUUID()}');`,
  );
  try {
    await legacy.postgres.exec(schemaSql);
    const chats = new ChatRows(legacy.database);
    const tombstone = await legacy.database.query(
      'SELECT chat_id::text AS data FROM deleted_chats',
    );
    const chatId = tombstone.rows[0].data;
    await chats.push(owner, {
      chats: [chat(chatId)],
      messages: [message(chatId)],
    });
    expect(await chats.pull(owner, 0)).toEqual({
      chats: [],
      messages: [],
      deletedChatIds: [],
      cursor: 0,
      more: false,
    });
  } finally {
    await legacy.postgres.close();
  }
});

test('the same push twice stores each row once and echoes nothing new', async () => {
  const chatId = randomUUID();
  const { dirty, ...row } = { ...chat(chatId), level: 'high' };
  const batch = { chats: [{ ...row, dirty }], messages: [message(chatId)] };
  await push(batch);
  const first = await pull(0);
  expect(first).toMatchObject({ chats: [row], messages: batch.messages });
  await push(batch);
  expect(await pull(first.cursor)).toEqual({
    chats: [],
    messages: [],
    deletedChatIds: [],
    cursor: first.cursor,
    more: false,
  });
  expect(await storedRows(chatId)).toBe(2);
});

test('pages cut at 200 rows and at about 1 MB return every row once, in order', async () => {
  const chatId = randomUUID();
  const small = Array.from({ length: 450 }, () => message(chatId));
  const large = Array.from({ length: 5 }, () =>
    message(chatId, 'x'.repeat(300_000)),
  );
  await push({ messages: small });
  await push({ messages: large });
  const pages = await pullAll();
  expect(pages.map(page => page.messages.length)).toEqual([200, 200, 53, 2]);
  expect(pages.flatMap(page => page.messages.map(row => row.id))).toEqual(
    [...small, ...large].map(row => row.id),
  );
});

test('a stale title push keeps the leaf another phone moved', async () => {
  const chatId = randomUUID();
  const created = chat(chatId);
  await push({ chats: [created] });
  const newLeaf = randomUUID();
  await push({
    chats: [
      chat(chatId, { leafId: newLeaf, updatedAt: 2_000, dirty: ['leaf'] }),
    ],
  });
  await push({
    chats: [{ ...created, title: 'Renamed', dirty: ['title'] }],
  });
  const [stored] = (await pull(0)).chats;
  expect(stored).toMatchObject({
    title: 'Renamed',
    leafId: newLeaf,
    updatedAt: 2_000,
  });
});

test('a deleted chat refuses later pushes, and a delete reclaims pushed rows', async () => {
  const deletedFirst = randomUUID();
  expect((await send(`chats/${deletedFirst}`, 'DELETE')).status).toBe(204);
  await push({
    chats: [chat(deletedFirst)],
    messages: [message(deletedFirst)],
  });
  const pushedFirst = randomUUID();
  await push({ chats: [chat(pushedFirst)], messages: [message(pushedFirst)] });
  expect((await send(`chats/${pushedFirst}`, 'DELETE')).status).toBe(204);
  expect(await storedRows(deletedFirst)).toBe(0);
  expect(await storedRows(pushedFirst)).toBe(0);
  expect(await pull(0)).toMatchObject({
    chats: [],
    messages: [],
    deletedChatIds: [deletedFirst, pushedFirst],
  });
});

test('an owner never pulls rows another owner pushed', async () => {
  const chatId = randomUUID();
  await push({ chats: [chat(chatId)], messages: [message(chatId)] });
  expect((await send(`chats/${randomUUID()}`, 'DELETE')).status).toBe(204);
  expect(await pull(0, otherToken)).toEqual({
    chats: [],
    messages: [],
    deletedChatIds: [],
    cursor: 0,
    more: false,
  });
});

test('a pull without a cursor is a client error', async () => {
  expect((await send('sync', 'GET')).status).toBe(400);
});

async function running(fields: Partial<Submission> = {}) {
  const input = { ...submission(), ...fields };
  await jobs.submit(owner, input, () => Promise.resolve('run'));
  await jobs.claim(owner, input.attemptId, 'run', 'claim');
  await jobs.update(owner, input.attemptId, 'claim', {
    text: 'Partial answer',
    reasoning: 'Thinking',
    actualModel: 'deepseek',
  });
  return input;
}

test('every terminal path stores the reply once, with its input choices', async () => {
  const completed = await running({
    picker: 'gpt-6.1-sol',
    level: 'high',
    retryModel: 'deepseek',
  });
  await jobs.update(owner, completed.attemptId, 'claim', {
    text: ' done',
    status: 'completed',
  });
  const stopped = await running();
  await jobs.requestCancellation(owner, stopped.attemptId);
  await jobs.requestCancellation(owner, stopped.attemptId);
  const stale = await running();
  now += staleAfterMs + 1;
  await jobs.reconcile(owner, stale.attemptId, staleAfterMs);
  await jobs.reconcile(owner, stale.attemptId, staleAfterMs);
  const { messages } = await pull(0);
  expect(messages).toEqual([
    {
      id: completed.attemptId,
      chatId: completed.chatId,
      parentId: completed.userTurnId,
      pathId: completed.pathId,
      role: 'assistant',
      status: 'completed',
      text: 'Partial answer done',
      reasoning: 'Thinking',
      imageCount: 0,
      picker: 'gpt-6.1-sol',
      level: 'high',
      retryModel: 'deepseek',
      actualModel: 'deepseek',
      error: null,
      createdAt: expect.any(Number),
    },
    expect.objectContaining({
      id: stopped.attemptId,
      status: 'stopped',
      text: 'Partial answer',
    }),
    expect.objectContaining({
      id: stale.attemptId,
      status: 'interrupted',
      text: 'Partial answer',
      error: expect.stringContaining('Retry creates a new answer'),
    }),
  ]);
});

test('acknowledging a reply keeps its stored text', async () => {
  const input = await running();
  await jobs.update(owner, input.attemptId, 'claim', { status: 'completed' });
  const { snapshot } = await jobs.get(owner, input.attemptId);
  await jobs.acknowledge(owner, input.attemptId, snapshot.sequence);
  expect((await jobs.get(owner, input.attemptId)).snapshot.text).toBe('');
  expect((await pull(0)).messages).toMatchObject([
    { id: input.attemptId, text: 'Partial answer' },
  ]);
});

test('a phone push of a stored reply cannot overwrite it', async () => {
  const input = await running();
  await jobs.update(owner, input.attemptId, 'claim', { status: 'completed' });
  const first = await pull(0);
  await push({
    messages: [
      {
        ...first.messages[0],
        status: 'interrupted',
        text: 'Local copy',
      },
    ],
  });
  expect(await pull(0)).toEqual(first);
});

test('a chat deleted while its reply runs keeps no message rows', async () => {
  const input = await running();
  expect((await send(`chats/${input.chatId}`, 'DELETE')).status).toBe(204);
  await expect(
    jobs.update(owner, input.attemptId, 'claim', { status: 'completed' }),
  ).rejects.toThrow(AttemptCancelled);
  expect(await storedRows(input.chatId)).toBe(0);
  expect(await pull(0)).toMatchObject({
    messages: [],
    deletedChatIds: [input.chatId],
  });
});

test('a stop before acceptance stores no reply', async () => {
  expect(await jobs.requestCancellation(owner, randomUUID())).toBeNull();
  expect((await pull(0)).messages).toEqual([]);
});

async function search(query: string, id = token): Promise<SearchResponse> {
  const response = await send('search', 'POST', JSON.stringify({ query }), id);
  expect(response.status).toBe(200);
  return decodeJson(searchResponseSchema, await response.text());
}

test('a word in a reply finds its chat with a snippet around it', async () => {
  const chatId = randomUUID();
  const reply = {
    ...message(
      chatId,
      'We could visit the aquarium on Saturday morning before lunch.',
    ),
    role: 'assistant' as const,
  };
  await push({
    chats: [chat(chatId, { title: 'Weekend' })],
    messages: [reply],
  });
  expect(await search('Aquarium')).toEqual({
    hits: [
      {
        chatId,
        messageId: reply.id,
        title: 'Weekend',
        snippet: expect.stringContaining('aquarium on Saturday'),
      },
    ],
  });
});

test('a prefix matches whole words, and a title match ranks above a body match', async () => {
  const titled = randomUUID();
  const body = randomUUID();
  const later = { updatedAt: 9_000 };
  await push({
    chats: [
      chat(titled, { title: 'Running shoes' }),
      chat(body, { title: 'Monday', ...later }),
    ],
    messages: [
      message(titled, 'Which size?'),
      message(body, 'I was running late'),
    ],
  });
  const { hits } = await search('runn');
  expect(hits.map(hit => [hit.chatId, hit.messageId])).toEqual([
    [titled, null],
    [body, expect.any(String)],
  ]);
});

test('query syntax in the input never reaches the database as syntax', async () => {
  const chatId = randomUUID();
  await push({
    chats: [chat(chatId)],
    messages: [message(chatId, 'alpha beta')],
  });
  for (const query of [
    'a & !b:*',
    '!!! ???',
    "al' | (be <-> :*",
    'x² ½ 日本語 ab-cd',
  ])
    expect((await search(query)).hits.length).toBeLessThanOrEqual(1);
  expect((await search('al & !be:*')).hits).toMatchObject([{ chatId }]);
});

test('search never matches a deleted chat or a chat another owner pushed', async () => {
  const kept = randomUUID();
  const deleted = randomUUID();
  await push({
    chats: [chat(kept), chat(deleted)],
    messages: [message(kept, 'zebra'), message(deleted, 'zebra')],
  });
  expect((await send(`chats/${deleted}`, 'DELETE')).status).toBe(204);
  const foreign = randomUUID();
  await push(
    { chats: [chat(foreign)], messages: [message(foreign, 'zebra')] },
    otherToken,
  );
  expect((await search('zebra')).hits.map(hit => hit.chatId)).toEqual([kept]);
});

test('a message with over 1 MB of distinct words saves and stays searchable', async () => {
  const chatId = randomUUID();
  const cjk = (n: number) => String.fromCodePoint(0x4e00 + n);
  const words = Array.from(
    { length: 200_000 },
    (_, i) => cjk(i % 20_000) + cjk(Math.floor(i / 20_000)),
  );
  const text = words.join(' ');
  expect(Buffer.byteLength(words.join(''))).toBeGreaterThan(1_048_575);
  await push({ chats: [chat(chatId)], messages: [message(chatId, text)] });
  expect((await search(words[0])).hits).toMatchObject([{ chatId }]);
});
