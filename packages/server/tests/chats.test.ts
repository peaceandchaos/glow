import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { bakedCatalog } from '../../../shared/catalog';
import {
  decodeJson,
  syncPageSchema,
  type SyncPage,
  type SyncPush,
} from '../../../shared/contracts';
import { handleRequest, type ApiServices } from '../src/api';
import { newSessionToken } from '../src/auth';
import { ChatRows } from '../src/chats';
import type { Database } from '../src/database';
import { JobRepository } from '../src/jobs';
import { schemaSql } from '../src/schema';
import { testDatabase } from './database';
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

beforeAll(async () => {
  ({ postgres, database } = await testDatabase());
  services = {
    ...(await signedIn(database, [
      [token, owner],
      [otherToken, 'apple-user-2'],
    ])),
    jobs: () => Promise.resolve(new JobRepository(database)),
    chats: () => Promise.resolve(new ChatRows(database)),
    dispatch: () => Promise.reject(new Error('Must not dispatch')),
    catalog: bakedCatalog,
  };
});
beforeEach(async () => {
  await postgres.exec(
    'TRUNCATE chat_owners, chats, chat_messages, deleted_chats',
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
