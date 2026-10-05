import {
  createChat,
  Network,
  openPhone,
  reopen,
  serverSnapshot,
  settled,
  shutdown,
  startServer,
  until,
  type Server,
} from './session-harness';

jest.setTimeout(60_000);
let server: Server;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => shutdown(server));

test('a turn is saved before any request and acknowledged only after its final result is saved', async () => {
  const phone = openPhone(server);
  const chat = phone.archive.createChat();
  phone.archive.setPicker(chat.id, 'kimi');
  const savedAtRequest: string[] = [];
  phone.network.beforeRequest = (method, path) => {
    const disk = reopen(phone.storage);
    const leaf = disk.chat(chat.id).leafId;
    const saved = disk.ancestry(leaf);
    savedAtRequest.push(
      `${method} ${path.split('/')[2]}: ${saved.map(m => `${m.role}:${m.status}:${m.text}`).join(' | ')}`,
    );
  };
  const reply = phone.session.send(chat.id, 'Hello', []);
  server.providers.script(reply.id).text('Hi ', 'there').end();
  await until(
    'the reply is settled',
    () => !phone.archive.metadata().jobIds.includes(reply.id),
  );
  expect(savedAtRequest).toEqual([
    'POST chat: user:completed:Hello | assistant:pending:',
    'POST jobs: user:completed:Hello | assistant:completed:Hi there',
  ]);
  expect(phone.archive.message(reply.id)).toMatchObject({
    status: 'completed',
    text: 'Hi there',
    actualModel: 'kimi',
    acknowledged: true,
  });
  expect(await serverSnapshot(server, reply.id)).toMatchObject({
    delivered: true,
    text: '',
  });
  expect(server.dispatched).toEqual([reply.id]);
});

test('partial text reaches storage on a bounded checkpoint, not on every token', async () => {
  const phone = openPhone(server);
  const chat = phone.archive.createChat();
  phone.archive.setPicker(chat.id, 'deepseek');
  const reply = phone.session.send(chat.id, 'Count', []);
  const tokens = Array.from({ length: 60 }, (_, index) => `${index} `);
  server.providers.script(reply.id).text(...tokens);
  await until(
    'all tokens are visible',
    () => phone.session.message(reply.id).text === tokens.join(''),
  );
  await until(
    'a checkpoint saved the partial text',
    () => reopen(phone.storage).message(reply.id).text === tokens.join(''),
  );
  const replyWrites = phone.storage.writes.filter(
    key => key === `archive/message/${reply.id}`,
  ).length;
  expect(replyWrites).toBeLessThan(tokens.length / 4);
  expect(reopen(phone.storage).message(reply.id).status).toBe('generating');
  server.providers.script(reply.id).end();
});

test('a restart recovers an accepted reply that finished while the app was closed, without a new version or generation', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Question', []);
  server.providers.script(reply.id).text('Before ');
  await until(
    'the partial text is saved',
    () => reopen(phone.storage).message(reply.id).text === 'Before ',
  );
  const disk = phone.storage.snapshot();
  phone.session.setLifecycle('background');
  server.providers.script(reply.id).text('after').end();
  await until(
    'the server finished without the phone',
    async () => (await serverSnapshot(server, reply.id)).status === 'completed',
  );
  const restarted = openPhone(server, disk);
  await settled(restarted, reply.id);
  expect(restarted.archive.message(reply.id)).toMatchObject({
    status: 'completed',
    text: 'Before after',
    acknowledged: true,
  });
  expect(restarted.archive.children(chat.id, reply.parentId)).toEqual([
    reply.id,
  ]);
  expect(restarted.network.requests).toEqual([
    `GET /v1/jobs/${reply.id}`,
    `POST /v1/jobs/${reply.id}/ack`,
  ]);
  expect(server.dispatched).toEqual([reply.id]);
  expect(server.providers.generations).toHaveLength(1);
});

test('a turn saved while offline is submitted after a restart under the same attempt id', async () => {
  const network = new Network();
  network.online = false;
  const phone = openPhone(server, undefined, network);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Offline question', []);
  await until(
    'the send is waiting for the network',
    () => phone.session.activity(reply.id).kind === 'waiting',
  );
  expect(phone.session.activity(reply.id)).toEqual({
    kind: 'waiting',
    error: 'Connection interrupted. This reply will reconnect.',
  });
  const disk = phone.storage.snapshot();
  phone.session.setLifecycle('background');
  expect(server.dispatched).toEqual([]);
  const restarted = openPhone(server, disk);
  server.providers.script(reply.id).text('Answered').end();
  await settled(restarted, reply.id);
  expect(restarted.archive.message(reply.id)).toMatchObject({
    status: 'completed',
    text: 'Answered',
  });
  expect(server.dispatched).toEqual([reply.id]);
});

test('a lost acceptance is recovered by resending the same attempt, with one generation', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  phone.network.loseResponse(
    (url, method) => method === 'POST' && url.endsWith('/v1/chat'),
  );
  const reply = phone.session.send(chat.id, 'Question', []);
  await until('the server accepted the lost submission', () =>
    server.dispatched.includes(reply.id),
  );
  server.providers.script(reply.id).text('Only once').end();
  await settled(phone, reply.id);
  expect(phone.archive.message(reply.id)).toMatchObject({
    status: 'completed',
    text: 'Only once',
  });
  expect(
    phone.network.requests.filter(request => request === 'POST /v1/chat'),
  ).toHaveLength(2);
  expect(server.dispatched).toEqual([reply.id]);
  expect(server.providers.generations).toHaveLength(1);
  expect(phone.archive.children(chat.id, reply.parentId)).toEqual([reply.id]);
});

test('an acknowledgement that is lost or never sent is resent, including after a restart', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  phone.network.loseResponse(
    (url, method) => method === 'POST' && url.endsWith('/ack'),
  );
  const first = phone.session.send(chat.id, 'One', []);
  server.providers.script(first.id).text('First').end();
  await settled(phone, first.id);
  expect(
    phone.network.requests.filter(
      request => request === `POST /v1/jobs/${first.id}/ack`,
    ),
  ).toHaveLength(2);
  expect(phone.archive.message(first.id)).toMatchObject({
    text: 'First',
    acknowledged: true,
  });
  expect(await serverSnapshot(server, first.id)).toMatchObject({
    delivered: true,
  });

  const second = phone.session.send(chat.id, 'Two', []);
  phone.network.beforeRequest = (_method, path) => {
    if (path.endsWith(`${second.id}/ack`)) phone.network.online = false;
  };
  server.providers.script(second.id).text('Second').end();
  await until(
    'the acknowledgement could not be sent',
    () => phone.session.activity(second.id).kind === 'waiting',
  );
  const disk = phone.storage.snapshot();
  phone.session.setLifecycle('background');
  expect(await serverSnapshot(server, second.id)).toMatchObject({
    status: 'completed',
    delivered: false,
  });
  const restarted = openPhone(server, disk);
  await settled(restarted, second.id);
  expect(restarted.archive.message(second.id)).toMatchObject({
    text: 'Second',
    acknowledged: true,
  });
  expect(await serverSnapshot(server, second.id)).toMatchObject({
    delivered: true,
    text: '',
  });
});

test('a saved reply is never replaced by a server receipt that was already released', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Question', []);
  server.providers.script(reply.id).text('Kept');
  await until(
    'the partial text is saved',
    () => reopen(phone.storage).message(reply.id).text === 'Kept',
  );
  const older = phone.storage.snapshot();
  server.providers.script(reply.id).text(' and finished').end();
  await settled(phone, reply.id);
  phone.session.setLifecycle('background');
  const restored = openPhone(server, older);
  await settled(restored, reply.id);
  expect(restored.archive.message(reply.id)).toMatchObject({
    status: 'interrupted',
    text: 'Kept',
    error:
      'The server released this reply before the phone saved it. Your saved text was preserved.',
  });
});

test('a cut stream is repaired from the server snapshot without duplicating text', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Question', []);
  server.providers.script(reply.id).text('a', 'b');
  await until(
    'the first text is visible',
    () => phone.session.message(reply.id).text === 'ab',
  );
  phone.network.cutStreams();
  server.providers.script(reply.id).text('c').end();
  await settled(phone, reply.id);
  expect(phone.archive.message(reply.id)).toMatchObject({
    status: 'completed',
    text: 'abc',
  });
  expect(phone.network.requests).toContain(`GET /v1/jobs/${reply.id}`);
  expect(server.dispatched).toEqual([reply.id]);
});

test('duplicate delivery is ignored without reconnecting or repeating text', async () => {
  server.duplicateDelivery = true;
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Question', []);
  const seen: string[] = [];
  phone.session.subscribe(() => {
    if (phone.archive.metadata().jobIds.includes(reply.id))
      seen.push(phone.session.message(reply.id).text);
  });
  server.providers.script(reply.id).text('one ', 'two ');
  await until(
    'both pieces are visible',
    () => phone.session.message(reply.id).text === 'one two ',
  );
  server.providers.script(reply.id).end();
  await settled(phone, reply.id);
  expect(phone.archive.message(reply.id).text).toBe('one two ');
  expect(seen.filter(text => !'one two '.startsWith(text))).toEqual([]);
  expect(phone.network.requests).toEqual([
    'POST /v1/chat',
    `POST /v1/jobs/${reply.id}/ack`,
  ]);
});

test('backgrounding flushes and detaches without cancelling; returning recovers the finished reply', async () => {
  const phone = openPhone(server, undefined, undefined, 60_000);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Question', []);
  server.providers.script(reply.id).text('Partial ');
  await until(
    'the partial text is visible',
    () => phone.session.message(reply.id).text === 'Partial ',
  );
  expect(reopen(phone.storage).message(reply.id).text).toBe('');
  phone.session.setLifecycle('inactive');
  expect(reopen(phone.storage).message(reply.id).text).toBe('Partial ');
  expect(phone.network.openStreams).toBe(1);
  phone.session.setLifecycle('background');
  expect(phone.session.activity(reply.id)).toEqual({ kind: 'idle' });
  await until('the reader is closed', () => phone.network.openStreams === 0);
  server.providers.script(reply.id).text('done').end();
  await until(
    'the server finished while the app was in the background',
    async () => (await serverSnapshot(server, reply.id)).status === 'completed',
  );
  expect(await serverSnapshot(server, reply.id)).toMatchObject({
    cancelRequested: false,
    delivered: false,
    text: 'Partial done',
  });
  phone.session.setLifecycle('active');
  await settled(phone, reply.id);
  expect(phone.archive.message(reply.id)).toMatchObject({
    status: 'completed',
    text: 'Partial done',
  });
  expect(server.providers.generations).toHaveLength(1);
});

test('a storage failure halts that reply without acknowledging it, and it recovers after resume', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Question', []);
  server.providers.script(reply.id).text('Saved');
  await until(
    'the text is visible',
    () => phone.session.message(reply.id).text === 'Saved',
  );
  const reported: string[] = [];
  phone.session.subscribe(() => {
    const activity = phone.session.activity(reply.id);
    if (activity.kind === 'waiting' || activity.kind === 'halted')
      reported.push(activity.error);
  });
  phone.storage.failing = true;
  server.providers.script(reply.id).end();
  await until(
    'the reply is halted',
    () => phone.session.activity(reply.id).kind === 'halted',
  );
  expect(phone.session.activity(reply.id)).toEqual({
    kind: 'halted',
    error: 'Saved chats could not be updated. Stored data was preserved.',
  });
  expect(new Set(reported)).toEqual(
    new Set(['Saved chats could not be updated. Stored data was preserved.']),
  );
  expect(phone.network.requests).not.toContain(`POST /v1/jobs/${reply.id}/ack`);
  expect(await serverSnapshot(server, reply.id)).toMatchObject({
    status: 'completed',
    delivered: false,
  });
  phone.storage.failing = false;
  phone.session.setLifecycle('background');
  phone.session.setLifecycle('active');
  await settled(phone, reply.id);
  expect(phone.archive.message(reply.id)).toMatchObject({
    status: 'completed',
    text: 'Saved',
  });
});

test('a corrupt saved reply is reported and preserved while other chats continue', async () => {
  const network = new Network();
  network.online = false;
  const phone = openPhone(server, undefined, network);
  const broken = phone.session.send(createChat(phone, 'kimi').id, 'A', []);
  const healthy = phone.session.send(createChat(phone, 'kimi').id, 'B', []);
  const disk = phone.storage.snapshot();
  phone.session.setLifecycle('background');
  const corrupt = '{"version":1,"id":"not-a-saved-reply"}';
  disk.values.set(`archive/message/${broken.id}`, corrupt);
  const restarted = openPhone(server, disk);
  server.providers.script(healthy.id).text('Fine').end();
  await settled(restarted, healthy.id);
  expect(restarted.archive.message(healthy.id).text).toBe('Fine');
  expect(restarted.session.activity(broken.id)).toEqual({
    kind: 'halted',
    error: 'This saved reply could not be read. Stored data was preserved.',
  });
  expect(disk.values.get(`archive/message/${broken.id}`)).toBe(corrupt);
  expect(server.dispatched).toEqual([healthy.id]);
});

test('a reply stream that closes cleanly before the reply finishes is watched again until the result arrives', async () => {
  const phone = openPhone(server);
  const manual = createChat(phone, 'kimi');
  const overHttp = phone.session.send(manual.id, 'HTTP', []);
  server.providers.script(overHttp.id).text('a');
  await until(
    'the HTTP reply is streaming',
    () => phone.session.message(overHttp.id).text === 'a',
  );
  phone.network.endStreams();
  server.providers.script(overHttp.id).text('b').end();
  await settled(phone, overHttp.id);
  expect(phone.archive.message(overHttp.id)).toMatchObject({
    status: 'completed',
    text: 'ab',
  });
  expect(phone.network.requests).toEqual([
    'POST /v1/chat',
    `GET /v1/jobs/${overHttp.id}`,
    `GET /v1/jobs/${overHttp.id}/events`,
    `POST /v1/jobs/${overHttp.id}/ack`,
  ]);

  const auto = phone.archive.createChat();
  phone.archive.setPicker(auto.id, 'auto');
  const overSocket = phone.session.send(auto.id, 'Socket', []);
  server.providers.script(overSocket.id).text('x');
  await until(
    'the socket reply is streaming',
    () => phone.session.message(overSocket.id).text === 'x',
  );
  server.sockets[0].deliver({ kind: 'detached', attemptId: overSocket.id });
  await until('the phone watches the reply again', () =>
    phone.network.requests.includes(`GET /v1/jobs/${overSocket.id}/events`),
  );
  server.providers.script(overSocket.id).text('y').end();
  await settled(phone, overSocket.id);
  expect(phone.archive.message(overSocket.id)).toMatchObject({
    status: 'completed',
    text: 'xy',
  });
  expect(server.dispatched).toEqual([overHttp.id, overSocket.id]);
});

test('a settled reply left in the pending index by a crash is removed on the next start', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Question', []);
  server.providers.script(reply.id).text('Answer').end();
  await settled(phone, reply.id);
  const disk = phone.storage.snapshot();
  phone.session.setLifecycle('background');
  const index = disk.getString('archive/index');
  if (!index) throw new Error('The fixture archive has no index');
  const metadata = JSON.parse(index);
  metadata.jobIds.push(reply.id);
  disk.values.set('archive/index', JSON.stringify(metadata));
  const restarted = openPhone(server, disk);
  await settled(restarted, reply.id);
  expect(restarted.archive.message(reply.id)).toMatchObject({
    status: 'completed',
    text: 'Answer',
    acknowledged: true,
  });
  expect(restarted.network.requests).toEqual([]);
});

test('an index that becomes unreadable is reported, never thrown from a lifecycle change or retry timer', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  phone.network.online = false;
  phone.session.deleteChat(chat.id);
  await until(
    'deletion is pending',
    () =>
      phone.session.notice() ===
      'Chat deletion is pending on the server. It will retry when connected.',
  );
  const index = phone.storage.getString('archive/index');
  if (!index) throw new Error('The fixture archive has no index');
  phone.storage.values.set('archive/index', '{"version":2}');
  let indexReads = 0;
  const getString = phone.storage.getString.bind(phone.storage);
  phone.storage.getString = key => {
    if (key === 'archive/index') indexReads += 1;
    return getString(key);
  };
  phone.session.setLifecycle('background');
  phone.session.setLifecycle('active');
  expect(phone.session.notice()).toBe(
    'Saved chats could not be updated. Stored data was preserved.',
  );
  const attempts = phone.network.requests.length;
  const reads = indexReads;
  await until('the deletion retried twice', () => indexReads >= reads + 2);
  expect(phone.network.requests).toHaveLength(attempts);
  phone.storage.values.set('archive/index', index);
  phone.network.online = true;
  await until(
    'the deletion reaches the server',
    () => phone.session.pendingDeletions().length === 0,
  );
});
