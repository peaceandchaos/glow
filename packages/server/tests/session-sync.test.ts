import { ChatArchive } from '../../app/src/state/archive';
import { createChatView } from '../../app/src/state/chatView';
import { ChatSession } from '../../app/src/state/session';
import { ChatSync } from '../../app/src/state/sync';
import type {
  ChatTransport,
  SyncTransport,
} from '../../app/src/network/transport';
import { seedChat } from '../../app/harness/seed';
import {
  createChat,
  MemoryStorage,
  openPhone,
  settled,
  shutdown,
  startServer,
  until,
  uuid,
  type Phone,
  type Server,
} from './session-harness';

jest.setTimeout(60_000);
let server: Server;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => shutdown(server));

async function sendAndSettle(phone: Phone, chatId: string, text: string) {
  const reply = phone.session.send(chatId, text, []);
  server.providers.script(reply.id).text(`Answer to ${text}`).end();
  await settled(phone, reply.id);
  return reply;
}

function pathTexts(phone: Phone, chatId: string): string[] {
  return phone.archive
    .ancestry(phone.archive.chat(chatId).leafId)
    .map(message => message.text);
}

async function rowCounts(chatId: string) {
  const result = await server.postgres.query<{ id: string; n: number }>(
    `SELECT id::text, count(*)::int AS n FROM chat_messages
     WHERE owner = $1 AND chat_id = $2 GROUP BY id`,
    [server.owner, chatId],
  );
  return result.rows;
}

test('a turn sent on one phone appears on another with the same ids', async () => {
  const a = openPhone(server);
  const chat = createChat(a, 'deepseek');
  const reply = await sendAndSettle(a, chat.id, 'Hello');
  await a.sync.run();

  const b = openPhone(server);
  await b.sync.run();
  expect(b.archive.recents().map(saved => saved.id)).toEqual([chat.id]);
  expect(
    b.archive
      .ancestry(b.archive.chat(chat.id).leafId)
      .map(message => message.id),
  ).toEqual([reply.parentId, reply.id]);
  expect(pathTexts(b, chat.id)).toEqual(['Hello', 'Answer to Hello']);
  expect(b.archive.chat(chat.id).picker).toBe('deepseek');
});

test('an empty phone restores every chat', async () => {
  const a = openPhone(server);
  const first = createChat(a, 'auto');
  await sendAndSettle(a, first.id, 'One');
  await sendAndSettle(a, first.id, 'Two');
  const second = createChat(a, 'kimi');
  await sendAndSettle(a, second.id, 'Three');
  a.archive.rename(first.id, 'Renamed first');
  await a.sync.run();

  const restored = openPhone(server);
  await restored.sync.run();
  expect(
    restored.archive.recents().map(chat => [chat.id, chat.title, chat.picker]),
  ).toEqual(
    a.archive.recents().map(chat => [chat.id, chat.title, chat.picker]),
  );
  expect(pathTexts(restored, first.id)).toEqual(pathTexts(a, first.id));
  expect(pathTexts(restored, second.id)).toEqual(['Three', 'Answer to Three']);
  expect(restored.archive.outboxBatch()).toBeNull();
});

test('a push whose response is lost after the server saved it is sent again and stored once', async () => {
  const a = openPhone(server);
  const chat = createChat(a, 'auto');
  await sendAndSettle(a, chat.id, 'Cut');
  a.network.loseResponse(
    (url, method) => method === 'POST' && url.endsWith('/v1/sync'),
  );
  await a.sync.run();
  expect(a.archive.outboxBatch()).not.toBeNull();
  expect(await rowCounts(chat.id)).toHaveLength(2);

  await a.sync.run();
  expect(a.archive.outboxBatch()).toBeNull();
  const counts = await rowCounts(chat.id);
  expect(counts.map(row => row.n)).toEqual([1, 1]);
});

test('a reply the server finished before replies were stored is uploaded once from an older archive', async () => {
  const a = openPhone(server);
  const chat = createChat(a, 'auto');
  const reply = await sendAndSettle(a, chat.id, 'Before the upgrade');
  await server.postgres.query('DELETE FROM chat_messages WHERE owner = $1', [
    server.owner,
  ]);
  a.session.setLifecycle('background');
  for (const key of [
    'archive/outbox',
    'archive/sync/cursor',
    'archive/sync/held',
  ])
    a.storage.values.delete(key);

  const upgraded = openPhone(server, a.storage.snapshot());
  await upgraded.sync.run();
  await upgraded.sync.run();
  const stored = await server.postgres.query<{ text: string }>(
    'SELECT text FROM chat_messages WHERE owner = $1 AND id = $2',
    [server.owner, reply.id],
  );
  expect(stored.rows).toEqual([{ text: 'Answer to Before the upgrade' }]);
  expect(await rowCounts(chat.id)).toHaveLength(2);
});

test('a chat deleted on one phone is purged on another that holds an unsent turn, and the server keeps nothing', async () => {
  const a = openPhone(server);
  const chat = createChat(a, 'auto');
  await sendAndSettle(a, chat.id, 'Shared');
  await a.sync.run();
  const b = openPhone(server);
  await b.sync.run();
  b.session.setLifecycle('background');
  b.archive.createTurn(chat.id, 'Unsent on B', []);

  a.session.deleteChat(chat.id);
  await until(
    'the server deleted the chat',
    () => a.session.pendingDeletions().length === 0,
  );
  await b.sync.run();
  expect(b.archive.hasChat(chat.id)).toBe(false);
  expect(b.archive.outboxBatch()).toBeNull();
  expect(b.archive.metadata().jobIds).toEqual([]);
  expect(await rowCounts(chat.id)).toEqual([]);
  const chats = await server.postgres.query(
    'SELECT 1 FROM chats WHERE owner = $1',
    [server.owner],
  );
  expect(chats.rows).toEqual([]);
});

test('start-up and opening a chat render from this phone when every network call fails', async () => {
  const storage = new MemoryStorage();
  let clock = 1_000;
  const seeding = new ChatArchive(storage, uuid, () => clock);
  seeding.recover();
  const older = seedChat(seeding, [{ question: 'Older', answer: 'Kept' }]);
  clock = 2_000;
  seedChat(seeding, [{ question: 'Newer', answer: 'Also kept' }]);
  const archive = new ChatArchive(storage, uuid);
  archive.recover();
  const offline = (): never => {
    throw new TypeError('Network request failed');
  };
  const transport: ChatTransport & SyncTransport = {
    get: offline,
    submit: offline,
    watch: offline,
    stop: offline,
    acknowledge: offline,
    deleteChat: offline,
    disconnect: () => undefined,
    pull: offline,
    push: offline,
    search: offline,
  };
  const session = new ChatSession({
    archive,
    transport,
    scheduleFrame: callback => setTimeout(callback, 0),
  });
  session.setLifecycle('active');
  const reports: string[] = [];
  const view = createChatView(
    archive,
    session,
    report => reports.push(report),
    transport.search,
  );
  const sync = new ChatSync(archive, transport, change =>
    view.getState().synced(change),
  );
  const running = sync.run();
  expect(view.getState().recents.map(chat => chat.title)).toEqual([
    'Newer',
    'Older',
  ]);
  view.getState().openChat(older);
  expect(view.getState().messages.map(message => message.text)).toEqual([
    'Older',
    'Kept',
  ]);
  await running;
  expect(reports).toEqual([]);
  session.setLifecycle('background');
});

test('a server without sync answers 404, and the phone shows nothing and keeps its queue', async () => {
  const a = openPhone(server);
  const chat = createChat(a, 'auto');
  await sendAndSettle(a, chat.id, 'Queued');
  const queued = a.archive.outboxBatch();
  a.network.respond = (_method, path) => (path === '/v1/sync' ? 404 : null);
  await a.sync.run();
  expect(a.network.requests).toContain('GET /v1/sync');
  expect(a.archive.outboxBatch()).toEqual(queued);
  expect(a.archive.cursor()).toBe(0);
  expect(a.session.notice()).toBeNull();
});
