import { ChatArchive } from '../../app/src/state/archive';
import { createChatView, historyPage } from '../../app/src/state/chatView';
import { longTurns, seedChat } from '../../app/harness/seed';
import {
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

function openView(phone: Phone) {
  const view = createChatView(phone.archive, phone.session, error => {
    throw new Error(error);
  });
  return () => view.getState();
}

function seededStorage() {
  const storage = new MemoryStorage();
  let clock = 1_000;
  const archive = new ChatArchive(storage, uuid, () => clock);
  const a = seedChat(archive, [
    { question: 'Alpha one', answer: 'A1' },
    { question: 'Alpha two', answer: 'A2' },
  ]);
  clock = 2_000;
  const b = seedChat(archive, [{ question: 'Bravo', answer: 'B1' }]);
  archive.setPicker(b, 'deepseek');
  clock = 3_000;
  const unsent = archive.createChat().id;
  return { storage, a, b, unsent };
}

test('Recents lists sent chats newest first without unsent chats, and opening one shows its saved path and picker', async () => {
  const { storage, a, b, unsent } = seededStorage();
  const phone = openPhone(server, storage);
  const state = openView(phone);
  expect(state().chatId).toBe(unsent);
  expect(state().recents.map(chat => chat.id)).toEqual([b, a]);
  expect(state().recents.map(chat => chat.title)).toEqual([
    'Bravo',
    'Alpha one',
  ]);

  state().openChat(a);
  expect(state().chatId).toBe(a);
  expect(phone.archive.metadata().currentChatId).toBe(a);
  expect(state().messages.map(message => message.text)).toEqual([
    'Alpha one',
    'A1',
    'Alpha two',
    'A2',
  ]);
  expect(state().isStreaming).toBe(false);

  expect(state().send('Alpha three')).toBe(state().messages.at(-2)?.id);
  const reply = state().messages[5];
  server.providers.script(reply.id).text('A3').end();
  await settled(phone, reply.id);
  expect(state().recents.map(chat => chat.id)).toEqual([a, b]);
  expect(state().recents[0].title).toBe('Alpha one');

  state().openChat(b);
  expect(phone.archive.chat(b).picker).toBe('deepseek');
  const relaunched = openPhone(server, phone.storage.snapshot());
  const after = openView(relaunched);
  expect(after().chatId).toBe(b);
  expect(after().messages.map(message => message.text)).toEqual([
    'Bravo',
    'B1',
  ]);
  expect(after().send('Bravo again')).toBe(after().messages.at(-2)?.id);
  expect(relaunched.archive.message(after().messages[3].id).picker).toBe(
    'deepseek',
  );
  expect(after().recents.map(chat => chat.id)).toEqual([b, a]);
});

test('a saved chat that cannot be read does not open, so it is not saved as the chat to reopen at launch', () => {
  const { storage, a, unsent } = seededStorage();
  const phone = openPhone(server, storage);
  const reports: string[] = [];
  const view = createChatView(phone.archive, phone.session, error =>
    reports.push(error),
  );
  const leafId = phone.archive.chat(a).leafId ?? '';
  storage.values.set(`archive/message/${leafId}`, '{"broken":true}');

  view.getState().openChat(a);
  expect(reports).toEqual(['Saved chats are unavailable.']);
  expect(view.getState().chatId).toBe(unsent);
  expect(phone.archive.metadata().currentChatId).toBe(unsent);
  const relaunched = openPhone(server, phone.storage.snapshot());
  expect(openView(relaunched)().chatId).toBe(unsent);
});

test('older history loads one page at a time until all 1,200 messages show in order, and a page costs the same at any depth', async () => {
  const storage = new MemoryStorage();
  const chatId = seedChat(new ChatArchive(storage, uuid), longTurns(600));
  const phone = openPhone(server, storage);
  const state = openView(phone);
  const all = phone.archive
    .ancestry(phone.archive.chat(chatId).leafId)
    .map(message => message.id);
  expect(all).toHaveLength(1_200);

  expect(state().messages).toHaveLength(historyPage);
  expect(state().messages.at(-1)?.text).toMatch(/^Answer 600\. /u);
  const newest = state().messages.at(-1);

  const reads: number[] = [];
  const spy = jest.spyOn(storage, 'getString');
  for (let page = 1; page < 1_200 / historyPage; page++) {
    const before = state().messages.length;
    spy.mockClear();
    state().loadOlder();
    reads.push(spy.mock.calls.length);
    expect(state().messages.length - before).toBe(
      Math.min(historyPage, 1_200 - before),
    );
  }
  spy.mockRestore();
  expect(reads).toHaveLength(1_200 / historyPage - 1);
  expect(Math.max(...reads)).toBe(reads[0]);
  expect(state().messages.map(message => message.id)).toEqual(all);
  expect(state().messages.at(-1)).toBe(newest);
  expect(state().messages[0].text).toBe('Question 1');

  state().loadOlder();
  expect(state().messages).toHaveLength(1_200);
  expect(state().send('One more')).toBe(state().messages.at(-2)?.id);
  expect(state().messages).toHaveLength(1_202);
  expect(state().messages[0].text).toBe('Question 1');
  const reply = state().messages[1_201];
  server.providers.script(reply.id).text('Done').end();
  await settled(phone, reply.id);
  await until('the view settles', () => !state().isStreaming);
  expect(state().messages[1_201]).toMatchObject({
    text: 'Done',
    status: 'done',
  });
});
