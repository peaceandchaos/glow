import { createChatView, draftPauseMs } from '../../app/src/state/chatView';
import {
  createChat,
  openPhone,
  reopen,
  serverSnapshot,
  settled,
  shutdown,
  startServer,
  until,
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
  const errors: string[] = [];
  const store = createChatView(phone.archive, phone.session, error =>
    errors.push(error),
  );
  return { errors, state: () => store.getState(), store };
}

test('a sent turn streams into the view without storage reads and keeps settled rows as the same objects', async () => {
  const phone = openPhone(server, undefined, undefined, 60_000);
  const chat = createChat(phone, 'kimi');
  const { state } = openView(phone);
  expect(state()).toMatchObject({
    chatId: chat.id,
    messages: [],
    isStreaming: false,
  });

  expect(state().send('Question')).toBe(state().messages.at(-2)?.id);
  expect(state().messages).toMatchObject([
    { role: 'user', text: 'Question', status: 'done' },
    { role: 'assistant', text: '', status: 'streaming' },
  ]);
  expect(state().isStreaming).toBe(true);
  const reply = state().messages[1];
  const user = state().messages[0];
  server.providers.script(reply.id).text('Hello ');
  await until(
    'the first text is visible',
    () => state().messages[1].text === 'Hello ',
  );

  const reads = jest.spyOn(phone.storage, 'getString');
  server.providers.script(reply.id).text('there ');
  await until(
    'the next text is visible',
    () => state().messages[1].text === 'Hello there ',
  );
  expect(reads).not.toHaveBeenCalled();
  reads.mockRestore();
  expect(state().messages[0]).toBe(user);
  const streaming = state().messages;
  phone.session.setLifecycle('active');
  expect(state().messages).toBe(streaming);

  server.providers.script(reply.id).text('world').end();
  await settled(phone, reply.id);
  await until('the view settles', () => !state().isStreaming);
  expect(state().messages).toMatchObject([
    { text: 'Question', status: 'done' },
    { text: 'Hello there world', status: 'done' },
  ]);
  const rows = state().messages;
  phone.session.setLifecycle('active');
  expect(state().messages).toBe(rows);
});

test('the waiting row says Thinking until the reply message starts, then Responding', async () => {
  const phone = openPhone(server);
  server.providers.selection = 'gpt-6.1-sol';
  createChat(phone, 'gpt-6.1-sol');
  const { state } = openView(phone);
  state().send('Question');
  const reply = state().messages[1];
  await until(
    'the server accepts the reply',
    () => phone.archive.message(reply.id).accepted,
  );
  expect(state().messages[1]).toMatchObject({
    text: '',
    status: 'streaming',
    statusLabel: 'Thinking',
  });
  server.providers.script(reply.id).item('message');
  await until(
    'the reply message starts',
    () => state().messages[1].statusLabel === 'Responding',
  );
  expect(state().messages[1]).toMatchObject({ text: '', status: 'streaming' });
  server.providers.script(reply.id).text('Hello').end();
  await settled(phone, reply.id);
  await until('the view settles', () => !state().isStreaming);
  expect(state().messages[1].statusLabel).toBeUndefined();
});

test('a reply that fails keeps its partial text on the existing error line', async () => {
  const phone = openPhone(server);
  createChat(phone, 'kimi');
  const { state } = openView(phone);
  state().send('Question');
  const reply = state().messages[1];
  server.providers.script(reply.id).text('Partial ').fail();
  await settled(phone, reply.id);
  await until('the view settles', () => !state().isStreaming);
  expect(phone.archive.message(reply.id).status).toBe('interrupted');
  expect(state().messages[1]).toMatchObject({
    text: 'Partial ',
    status: 'error',
  });
});

test('New Chat leaves a running reply alone, reuses an unsent chat, and replies in two chats stream in parallel', async () => {
  const phone = openPhone(server);
  const a = createChat(phone, 'kimi');
  const { state } = openView(phone);
  state().send('A');
  const aReply = state().messages[1];
  server.providers.script(aReply.id).text('A1 ');
  await until('A is streaming', () => state().messages[1].text === 'A1 ');

  state().newChat();
  const b = state().chatId;
  expect(b).not.toBe(a.id);
  expect(state()).toMatchObject({ messages: [], isStreaming: false });
  const chats = phone.archive.metadata().chatIds.length;
  state().newChat();
  expect(state().chatId).toBe(b);
  expect(phone.archive.metadata().chatIds).toHaveLength(chats);

  state().send('B');
  const bReply = state().messages[1];
  server.providers.script(bReply.id).text('B1 ');
  await until(
    'both replies are streaming',
    () =>
      state().messages[1].text === 'B1 ' &&
      phone.session.message(aReply.id).text === 'A1 ',
  );
  server.providers.script(aReply.id).text('A2').end();
  await settled(phone, aReply.id);
  expect(state().isStreaming).toBe(true);
  server.providers.script(bReply.id).text('B2').end();
  await settled(phone, bReply.id);
  await until('the view settles', () => !state().isStreaming);
  expect(state().messages).toMatchObject([
    { text: 'B' },
    { text: 'B1 B2', status: 'done' },
  ]);
  expect(phone.archive.message(aReply.id)).toMatchObject({
    status: 'completed',
    text: 'A1 A2',
  });
});

test('Stop in the view cancels on the server; offline, the stop control stays until the server confirms', async () => {
  const phone = openPhone(server);
  createChat(phone, 'kimi');
  const { state } = openView(phone);
  state().send('Online');
  const online = state().messages[1];
  server.providers.script(online.id).text('Partial ');
  await until(
    'the partial text is visible',
    () => state().messages[1].text === 'Partial ',
  );
  state().stop();
  await settled(phone, online.id);
  await until('the view settles', () => !state().isStreaming);
  expect(state().messages[1]).toMatchObject({
    text: 'Partial ',
    status: 'done',
  });
  expect(await serverSnapshot(server, online.id)).toMatchObject({
    status: 'stopped',
    cancelRequested: true,
  });

  state().send('Offline');
  const offline = state().messages[3];
  server.providers.script(offline.id).text('Partial ');
  await until(
    'the partial text is visible',
    () => state().messages[3].text === 'Partial ',
  );
  phone.network.online = false;
  phone.network.cutStreams();
  state().stop();
  await until(
    'Stop is waiting for the network',
    () => phone.session.activity(offline.id).kind === 'waiting',
  );
  expect(state().isStreaming).toBe(true);
  expect(state().messages[3].status).toBe('streaming');
  phone.network.online = true;
  await settled(phone, offline.id);
  await until('the view settles', () => !state().isStreaming);
  expect(state().messages[3]).toMatchObject({ status: 'done' });
  expect(await serverSnapshot(server, offline.id)).toMatchObject({
    status: 'stopped',
    cancelRequested: true,
  });
});

test('background and resume, then a relaunch mid-reply, show the same reply with no new version', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const { state } = openView(phone);
  state().send('First');
  const first = state().messages[1];
  server.providers.script(first.id).text('Before ');
  await until(
    'the text is visible',
    () => state().messages[1].text === 'Before ',
  );
  phone.session.setLifecycle('background');
  server.providers.script(first.id).text('after').end();
  await until(
    'the server finished in the background',
    async () => (await serverSnapshot(server, first.id)).status === 'completed',
  );
  expect(state().messages[1]).toMatchObject({
    text: 'Before ',
    status: 'streaming',
  });
  phone.session.setLifecycle('active');
  await settled(phone, first.id);
  await until('the view settles', () => !state().isStreaming);
  expect(state().messages[1]).toMatchObject({
    text: 'Before after',
    status: 'done',
  });

  state().send('Second');
  const second = state().messages[3];
  server.providers.script(second.id).text('Saved ');
  await until(
    'the partial text is on disk',
    () => reopen(phone.storage).message(second.id).text === 'Saved ',
  );
  const disk = phone.storage.snapshot();
  phone.session.setLifecycle('background');
  const relaunched = openPhone(server, disk);
  const after = openView(relaunched);
  expect(after.state()).toMatchObject({ chatId: chat.id, isStreaming: true });
  expect(after.state().messages).toMatchObject([
    { text: 'First' },
    { text: 'Before after', status: 'done' },
    { text: 'Second' },
    { id: second.id, text: 'Saved ', status: 'streaming' },
  ]);
  server.providers.script(second.id).text('rest').end();
  await settled(relaunched, second.id);
  await until('the relaunched view settles', () => !after.state().isStreaming);
  expect(after.state().messages[3]).toMatchObject({
    text: 'Saved rest',
    status: 'done',
  });
  const parentId = relaunched.archive.message(second.id).parentId;
  expect(relaunched.archive.children(chat.id, parentId)).toEqual([second.id]);
  expect(server.dispatched).toEqual([first.id, second.id]);
  expect(server.providers.generations).toHaveLength(2);
});

test('a rejected send reports why, saves nothing, and returns null so the composer keeps its text', async () => {
  const phone = openPhone(server);
  createChat(phone, 'kimi');
  const { errors, state } = openView(phone);
  expect(state().send('   ')).toBeNull();
  expect(errors).toEqual(['Write a message or choose an image.']);
  expect(state().messages).toEqual([]);

  expect(state().send('One')).toBe(state().messages.at(-2)?.id);
  expect(state().send('Two')).toBeNull();
  expect(errors.at(-1)).toBe(
    'Wait for this reply or stop it before sending another message.',
  );
  expect(state().messages.map(message => message.text)).toEqual(['One', '']);
  expect(phone.archive.metadata().jobIds).toEqual([state().messages[1].id]);
});

test('a send that saved shows its turn even when the chat path cannot be read again', () => {
  const phone = openPhone(server);
  createChat(phone, 'kimi');
  const { errors, state } = openView(phone);
  jest.spyOn(phone.session, 'path').mockImplementation(() => {
    throw new Error('Saved chats are unavailable.');
  });
  expect(state().send('Question')).toBe(state().messages.at(-2)?.id);
  expect(errors).toEqual([]);
  expect(state().messages).toMatchObject([
    { role: 'user', text: 'Question', status: 'done' },
    { role: 'assistant', status: 'streaming' },
  ]);
  expect(state().isStreaming).toBe(true);
});

test('a halted reply shows its error and the composer offers Send, then it streams again after resume', async () => {
  const phone = openPhone(server);
  createChat(phone, 'kimi');
  const { state } = openView(phone);
  state().send('Question');
  const reply = state().messages[1];
  phone.storage.failing = true;
  await until(
    'the reply is halted',
    () => phone.session.activity(reply.id).kind === 'halted',
  );
  expect(phone.session.message(reply.id).status).toBe('accepted');
  expect(state().messages[1].status).toBe('error');
  expect(state().isStreaming).toBe(false);

  phone.storage.failing = false;
  phone.session.setLifecycle('background');
  phone.session.setLifecycle('active');
  await until('the reply streams again', () => state().isStreaming);
  expect(state().messages[1].status).toBe('streaming');
  server.providers.script(reply.id).text('Answer').end();
  await settled(phone, reply.id);
  await until('the view settles', () => !state().isStreaming);
  expect(state().messages[1]).toMatchObject({ text: 'Answer', status: 'done' });
});

test('an image the contract rejects is reported in plain words and nothing is saved', () => {
  const phone = openPhone(server);
  createChat(phone, 'kimi');
  const { errors, state } = openView(phone);
  const heic = {
    uri: 'file:///tmp/a.heic',
    dataUrl: 'data:image/heic;base64,AAAA',
  };
  expect(state().send('Look', [heic])).toBeNull();
  expect(errors).toEqual(['These images can’t be sent.']);
  expect(state().messages).toEqual([]);
  expect(phone.archive.metadata().jobIds).toEqual([]);
});

test('a typed draft is saved once typing pauses, comes back after a relaunch, and is deleted on send and when cleared', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const { state } = openView(phone);
  const relaunch = () => openView(openPhone(server, phone.storage.snapshot()));
  const onDisk = () => reopen(phone.storage).draft(chat.id);
  const writes = phone.storage.writes.length;
  for (const text of ['H', 'Ha', 'Hal', 'Half a thought'])
    state().saveDraftAfterPause(chat.id, text);
  expect(phone.storage.writes).toHaveLength(writes);
  await until('the draft is on disk', () => onDisk() === 'Half a thought');
  expect(phone.storage.writes).toHaveLength(writes + 1);
  expect(relaunch().state().draftText(chat.id)).toBe('Half a thought');

  state().saveDraftAfterPause(chat.id, '');
  await until('the cleared draft is gone from disk', () => onDisk() === '');
  expect(relaunch().state().draftText(chat.id)).toBe('');

  state().saveDraftAfterPause(chat.id, 'Question');
  await until('the new draft is on disk', () => onDisk() === 'Question');
  state().saveDraftAfterPause(chat.id, 'Question?');
  expect(state().send('Question?')).toBe(state().messages.at(-2)?.id);
  expect(onDisk()).toBe('');
  await new Promise(resolve => setTimeout(resolve, 2 * draftPauseMs));
  expect(relaunch().state().draftText(chat.id)).toBe('');
});

test('leaving the app saves a draft at once, without waiting for typing to pause', () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const { state } = openView(phone);
  state().saveDraftAfterPause(chat.id, 'Half a thought');
  state().saveDraftsNow();
  const relaunched = openView(openPhone(server, phone.storage.snapshot()));
  expect(relaunched.state().draftText(chat.id)).toBe('Half a thought');
});

test('a draft that cannot be read or saved does not block typing or sending', () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const first = openView(phone);
  const before = new Set(phone.storage.getAllKeys());
  first.state().saveDraftAfterPause(chat.id, 'Saved');
  first.state().saveDraftsNow();
  const draftKeys = phone.storage.getAllKeys().filter(key => !before.has(key));
  expect(draftKeys).toHaveLength(1);
  const { getString, set, remove } = phone.storage;
  const fail = (key: string) => {
    if (draftKeys.includes(key)) throw new Error('Simulated storage failure');
  };
  jest.spyOn(phone.storage, 'getString').mockImplementation(key => {
    fail(key);
    return getString.call(phone.storage, key);
  });
  jest.spyOn(phone.storage, 'set').mockImplementation((key, value) => {
    fail(key);
    set.call(phone.storage, key, value);
  });
  jest.spyOn(phone.storage, 'remove').mockImplementation(key => {
    fail(key);
    remove.call(phone.storage, key);
  });

  const { errors, state } = openView(phone);
  expect(state().draftText(chat.id)).toBe('');
  state().saveDraftAfterPause(chat.id, 'Question');
  state().saveDraftsNow();
  expect(state().send('Question')).toBe(state().messages.at(-2)?.id);
  expect(errors).toEqual([]);
  expect(state().messages[0]).toMatchObject({ role: 'user', text: 'Question' });
});
