import { randomUUID } from 'node:crypto';
import type { ContextCheckpoint, Submission } from '../../../shared/contracts';
import type { Receive } from '../../app/src/network/transport';
import { handleRequest } from '../src/api';
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
  type Phone,
  type Server,
} from './session-harness';

jest.setTimeout(60_000);
let server: Server;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => shutdown(server));

function serverInput(attemptId: string): Submission {
  const generation = server.providers.generations.find(
    item => item.input.attemptId === attemptId,
  );
  if (!generation) throw new Error(`No generation for ${attemptId}`);
  return generation.input;
}

function texts(phone: Phone, chatId: string): string[] {
  return phone.session
    .path(phone.archive.chat(chatId).leafId)
    .map(message => message.text);
}

test('one chat’s rejection and reconnect never pause or cancel another chat', async () => {
  const phone = openPhone(server);
  const a = createChat(phone, 'kimi');
  const b = createChat(phone, 'kimi');
  const c = createChat(phone, 'kimi');
  const bReply = phone.session.send(b.id, 'B', []);
  const cReply = phone.session.send(c.id, 'C', []);
  server.providers.script(bReply.id).text('B1 ');
  server.providers.script(cReply.id).text('C1 ');
  await until(
    'B and C are streaming',
    () =>
      phone.session.message(bReply.id).text === 'B1 ' &&
      phone.session.message(cReply.id).text === 'C1 ',
  );
  const blockerTurn = randomUUID();
  await server.jobs.submit(
    server.owner,
    {
      version: 1,
      attemptId: randomUUID(),
      chatId: a.id,
      pathId: a.basePathId,
      userTurnId: blockerTurn,
      picker: 'kimi',
      retryModel: null,
      checkpoints: [],
      history: [
        {
          id: blockerTurn,
          parentId: null,
          role: 'user',
          text: 'Held elsewhere',
          images: [],
          complete: true,
        },
      ],
    },
    () => Promise.resolve('held'),
  );
  const aReply = phone.session.send(a.id, 'A', []);
  await settled(phone, aReply.id);
  expect(phone.archive.message(aReply.id)).toMatchObject({
    status: 'failed',
    accepted: false,
    error: 'This conversation path already has a reply in progress.',
  });
  expect(
    phone.network.requests.filter(request => request === 'POST /v1/chat'),
  ).toHaveLength(3);
  phone.network.cutStreams();
  expect(() => phone.session.send(b.id, 'Queued', [])).toThrow(
    'Wait for this reply or stop it before sending another message.',
  );
  expect(phone.archive.children(b.id, bReply.id)).toEqual([]);
  server.providers.script(bReply.id).text('B2').end();
  server.providers.script(cReply.id).text('C2').end();
  await settled(phone, bReply.id);
  await settled(phone, cReply.id);
  expect(phone.archive.message(bReply.id)).toMatchObject({
    status: 'completed',
    text: 'B1 B2',
  });
  expect(phone.archive.message(cReply.id)).toMatchObject({
    status: 'completed',
    text: 'C1 C2',
  });
  for (const id of [bReply.id, cReply.id])
    expect(await serverSnapshot(server, id)).toMatchObject({
      cancelRequested: false,
      delivered: true,
    });
  expect(server.dispatched).toEqual([bReply.id, cReply.id]);
});

test('Auto saves the chosen model over the socket; a failed choice stays visible and Retry needs an explicit model', async () => {
  const phone = openPhone(server);
  const chat = phone.archive.createChat();
  expect(chat.picker).toBe('auto');
  server.providers.selection = 'deepseek';
  const chosen = phone.session.send(chat.id, 'Pick one', []);
  server.providers.script(chosen.id).text('Chosen').end();
  await settled(phone, chosen.id);
  expect(reopen(phone.storage).message(chosen.id)).toMatchObject({
    picker: 'auto',
    actualModel: 'deepseek',
    text: 'Chosen',
  });

  server.providers.selection = 'fail';
  const failed = phone.session.send(chat.id, 'Again', []);
  await settled(phone, failed.id);
  expect(phone.archive.message(failed.id)).toMatchObject({
    status: 'failed',
    actualModel: null,
    error: 'The model chooser could not answer.',
  });
  expect(server.providers.generations).toHaveLength(1);
  expect(phone.archive.children(chat.id, failed.parentId)).toEqual([failed.id]);
  expect(() => phone.session.retry(failed.id)).toThrow(
    'Choose a model for this retry.',
  );
  const retried = phone.session.retry(failed.id, 'kimi');
  server.providers.script(retried.id).text('Explicit').end();
  await settled(phone, retried.id);
  expect(server.providers.selections).toBe(2);
  expect(server.providers.generations.at(-1)).toMatchObject({
    model: 'kimi',
    input: { picker: 'auto', retryModel: 'kimi' },
  });
  expect(phone.archive.children(chat.id, failed.parentId)).toEqual([
    failed.id,
    retried.id,
  ]);
  expect(
    phone.network.requests.filter(request => request === 'POST /v1/chat'),
  ).toHaveLength(1);

  phone.archive.setPicker(chat.id, 'gpt-6.1-sol');
  const inherited = phone.archive.createChat();
  expect(inherited.picker).toBe('gpt-6.1-sol');
  const gpt = phone.session.send(inherited.id, 'Socket', []);
  server.providers.script(gpt.id).text('Respon', 'ses');
  await until(
    'Responses text is visible',
    () => phone.session.message(gpt.id).text === 'Responses',
  );
  server.providers.script(gpt.id).end();
  await settled(phone, gpt.id);
  expect(phone.archive.message(gpt.id)).toMatchObject({
    picker: 'gpt-6.1-sol',
    actualModel: 'gpt-6.1-sol',
    text: 'Responses',
  });
});

test('Retry adds a version with the original model and pre-answer context; continuations and checkpoints stay on their own paths', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const first = phone.session.send(chat.id, 'Q1', []);
  server.providers.script(first.id).text('Partial');
  await until(
    'the first answer is streaming',
    () => phone.session.message(first.id).text === 'Partial',
  );
  phone.session.stop(first.id);
  await settled(phone, first.id);
  const questionId = first.parentId;
  if (!questionId) throw new Error('A reply needs its question');

  const followUp = phone.session.send(chat.id, 'Q2', []);
  server.providers.script(followUp.id).text('A2').end();
  await settled(phone, followUp.id);
  expect(
    serverInput(followUp.id).history.map(({ text, complete }) => ({
      text,
      complete,
    })),
  ).toEqual([
    { text: 'Q1', complete: true },
    { text: 'Partial', complete: false },
    { text: 'Q2', complete: true },
  ]);

  const version = phone.session.retry(first.id);
  const checkpoint: ContextCheckpoint = {
    model: 'kimi',
    throughMessageId: questionId,
    method: 'kimi-summary',
    items: [],
    summary: 'Summary of Q1',
  };
  server.providers.script(version.id).text('Complete').end(checkpoint);
  await settled(phone, version.id);
  expect(serverInput(version.id)).toMatchObject({
    retryModel: 'kimi',
    history: [{ id: questionId, text: 'Q1' }],
  });
  expect(serverInput(version.id).history).toHaveLength(1);

  const onVersion = phone.session.send(chat.id, 'Q3', []);
  server.providers.script(onVersion.id).text('A3').end();
  await settled(phone, onVersion.id);
  expect(serverInput(onVersion.id).history.map(entry => entry.text)).toEqual([
    'Q1',
    'Complete',
    'Q3',
  ]);
  expect(serverInput(onVersion.id).checkpoints).toEqual([checkpoint]);

  phone.archive.selectVersion(first.id);
  expect(texts(phone, chat.id)).toEqual(['Q1', 'Partial', 'Q2', 'A2']);
  const onFirst = phone.session.send(chat.id, 'Q4', []);
  server.providers.script(onFirst.id).text('A4').end();
  await settled(phone, onFirst.id);
  expect(serverInput(onFirst.id).checkpoints).toEqual([]);

  phone.archive.selectVersion(version.id);
  expect(texts(phone, chat.id)).toEqual(['Q1', 'Complete', 'Q3', 'A3']);
  expect(phone.archive.children(chat.id, questionId)).toEqual([
    first.id,
    version.id,
  ]);
});

test('Stop online cancels the server attempt and keeps the stopped text', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Question', []);
  server.providers.script(reply.id).text('Partial ');
  await until(
    'the partial text is visible',
    () => phone.session.message(reply.id).text === 'Partial ',
  );
  phone.session.stop(reply.id);
  await settled(phone, reply.id);
  expect(phone.archive.message(reply.id)).toMatchObject({
    status: 'stopped',
    text: 'Partial ',
    cancelPending: false,
  });
  expect(await serverSnapshot(server, reply.id)).toMatchObject({
    status: 'stopped',
    cancelRequested: true,
    delivered: true,
  });
  await server.settle();
  expect(server.providers.generations).toHaveLength(1);
});

test('Stop while offline stays pending across a restart and is sent on reconnect', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Question', []);
  server.providers.script(reply.id).text('Partial ');
  await until(
    'the partial text is visible',
    () => phone.session.message(reply.id).text === 'Partial ',
  );
  phone.network.online = false;
  phone.network.cutStreams();
  phone.session.stop(reply.id);
  expect(reopen(phone.storage).message(reply.id)).toMatchObject({
    cancelPending: true,
    text: 'Partial ',
  });
  await until(
    'Stop is waiting for the network',
    () => phone.session.activity(reply.id).kind === 'waiting',
  );
  expect(phone.session.activity(reply.id)).toEqual({
    kind: 'waiting',
    error: 'Stop is pending. It will be sent when the server is reachable.',
  });
  server.providers.script(reply.id).text('more');
  await until(
    'the server kept generating',
    async () =>
      (await serverSnapshot(server, reply.id)).text === 'Partial more',
  );
  const disk = phone.storage.snapshot();
  phone.session.setLifecycle('background');
  const restarted = openPhone(server, disk);
  await settled(restarted, reply.id);
  expect(restarted.archive.message(reply.id)).toMatchObject({
    status: 'stopped',
    text: 'Partial more',
    cancelPending: false,
  });
  expect(await serverSnapshot(server, reply.id)).toMatchObject({
    status: 'stopped',
    cancelRequested: true,
  });
  expect(restarted.network.requests[0]).toBe(`POST /v1/jobs/${reply.id}/stop`);
});

test('Stop before acceptance leaves a server tombstone, so the unsent turn can never start later', async () => {
  const network = new Network();
  network.online = false;
  const phone = openPhone(server, undefined, network);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Never mind', []);
  phone.session.stop(reply.id);
  network.online = true;
  await settled(phone, reply.id);
  expect(phone.archive.message(reply.id)).toMatchObject({
    status: 'stopped',
    accepted: false,
    text: '',
  });
  const late = await handleRequest(
    new Request('http://127.0.0.1:8787/v1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': server.device,
      },
      body: JSON.stringify({
        kind: 'submit',
        submission: phone.archive.submission(reply.id),
      }),
    }),
    server.services,
  );
  expect(late.status).toBe(410);
  expect(server.dispatched).toEqual([]);
});

test('deleting a chat cancels its server work, and nothing more is sent or saved for it', async () => {
  const phone = openPhone(server);
  const kept = createChat(phone, 'kimi');
  const chat = createChat(phone, 'kimi');
  const readers: Receive[] = [];
  const submit = phone.transport.submit.bind(phone.transport);
  phone.transport.submit = (input, receive, signal) => {
    readers.push(receive);
    return submit(input, receive, signal);
  };
  const reply = phone.session.send(chat.id, 'Delete me', []);
  server.providers.script(reply.id).text('Visible ');
  await until(
    'the reply is streaming',
    () => phone.session.message(reply.id).text === 'Visible ',
  );
  const last = await serverSnapshot(server, reply.id);
  const before = phone.network.requests.length;
  phone.session.deleteChat(chat.id);
  for (const receive of readers) {
    receive({
      kind: 'event',
      event: {
        version: 1,
        attemptId: reply.id,
        sequence: last.sequence + 1,
        kind: 'provider',
        wire: 'gateway',
        raw: JSON.stringify({
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: 'late' } }],
        }),
      },
    });
    receive({
      kind: 'accepted',
      snapshot: {
        ...last,
        sequence: last.sequence + 2,
        status: 'completed',
        text: 'Visible late',
      },
    });
  }
  expect(() => phone.session.message(reply.id)).toThrow(
    'A saved message is missing. Stored data was preserved.',
  );
  await until(
    'the server confirmed deletion',
    () => phone.session.pendingDeletions().length === 0,
  );
  await server.settle();
  expect(readers).toHaveLength(1);
  expect(phone.network.requests.slice(before)).toEqual([
    `DELETE /v1/chats/${chat.id}`,
  ]);
  expect(await serverSnapshot(server, reply.id)).toMatchObject({
    status: 'deleted',
    cancelRequested: true,
    text: '',
  });
  expect(phone.archive.hasChat(chat.id)).toBe(false);
  expect(
    phone.storage.getAllKeys().filter(key => key.includes(chat.id)),
  ).toEqual([]);
  expect(phone.archive.recents().map(item => item.id)).not.toContain(chat.id);
  expect(phone.archive.hasChat(kept.id)).toBe(true);
});

test('a chat deleted offline stays deleted across a restart and its server work is cancelled on reconnect', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  const reply = phone.session.send(chat.id, 'Delete me', []);
  server.providers.script(reply.id).text('Visible ');
  await until(
    'the reply is streaming',
    () => phone.session.message(reply.id).text === 'Visible ',
  );
  phone.network.online = false;
  phone.network.cutStreams();
  phone.session.deleteChat(chat.id);
  expect(phone.archive.hasChat(chat.id)).toBe(false);
  await until(
    'deletion is reported as pending',
    () =>
      phone.session.notice() ===
      'Chat deletion is pending on the server. It will retry when connected.',
  );
  expect(await serverSnapshot(server, reply.id)).toMatchObject({
    status: 'generating',
    cancelRequested: false,
  });
  const disk = phone.storage.snapshot();
  phone.session.setLifecycle('background');
  const restarted = openPhone(server, disk);
  expect(restarted.session.pendingDeletions()).toEqual([chat.id]);
  await until(
    'the server confirmed deletion',
    () => restarted.session.pendingDeletions().length === 0,
  );
  await server.settle();
  expect(await serverSnapshot(server, reply.id)).toMatchObject({
    status: 'deleted',
    cancelRequested: true,
  });
  expect(restarted.archive.hasChat(chat.id)).toBe(false);
  expect(restarted.network.requests).toEqual([`DELETE /v1/chats/${chat.id}`]);
  expect(restarted.session.notice()).toBeNull();
});

test('a server error for another command does not fail an unsent reply that shares its socket', async () => {
  const phone = openPhone(server);
  const chat = phone.archive.createChat();
  let release = () => {};
  server.dispatchGate = new Promise<void>(resolve => {
    release = resolve;
  });
  const reply = phone.session.send(chat.id, 'Held before acceptance', []);
  await until('the submission reached the server', () =>
    server.dispatched.includes(reply.id),
  );
  server.sockets[0].inject('{"kind":"malformed"}');
  await until(
    'the unattributed error ended the reader',
    () => phone.session.activity(reply.id).kind !== 'connected',
  );
  release();
  server.dispatchGate = null;
  server.providers.script(reply.id).text('Delivered').end();
  await settled(phone, reply.id);
  expect(phone.archive.message(reply.id)).toMatchObject({
    status: 'completed',
    text: 'Delivered',
  });
  expect(server.dispatched).toEqual([reply.id]);
});

test('chat deletion finishes on 404 or 410, retries 5xx, and stops retrying a refusal until the app reopens', async () => {
  const phone = openPhone(server);
  const [gone, missing, refused, busy] = [0, 1, 2, 3].map(
    () => createChat(phone, 'kimi').id,
  );
  const statuses = new Map([
    [gone, 410],
    [missing, 404],
    [refused, 400],
    [busy, 503],
  ]);
  phone.network.respond = (method, path) =>
    method === 'DELETE'
      ? (statuses.get(path.split('/').at(-1) ?? '') ?? null)
      : null;
  const deletes = (id: string) =>
    phone.network.requests.filter(
      request => request === `DELETE /v1/chats/${id}`,
    ).length;
  phone.network.online = false;
  for (const id of [gone, missing, refused, busy]) phone.session.deleteChat(id);
  phone.network.online = true;
  await until('the busy deletion is retried', () => deletes(busy) >= 3);
  expect(phone.session.pendingDeletions()).toEqual([refused, busy]);
  statuses.delete(busy);
  await until(
    'the busy deletion reached the server',
    () => phone.session.pendingDeletions().length === 1,
  );
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(phone.session.pendingDeletions()).toEqual([refused]);
  expect(deletes(refused)).toBe(1);
  expect(phone.session.notice()).toBe(
    'The server refused to delete a chat. It stays deleted on this phone, and the app tries again when reopened.',
  );
  expect(phone.archive.hasChat(refused)).toBe(false);
  phone.session.setLifecycle('background');
  phone.session.setLifecycle('active');
  await until(
    'the refused deletion is tried again',
    () => deletes(refused) === 2,
  );
});

test('a submission the server cannot accept fails once on the socket, as it does over HTTP', async () => {
  const phone = openPhone(server);
  phone.network.rewrite = body => body.replace('"version":1', '"version":2');
  const overSocket = phone.session.send(phone.archive.createChat().id, 'A', []);
  const overHttp = phone.session.send(createChat(phone, 'kimi').id, 'B', []);
  await settled(phone, overSocket.id);
  await settled(phone, overHttp.id);
  expect(phone.archive.message(overSocket.id)).toMatchObject({
    status: 'failed',
    accepted: false,
    error: 'The server could not accept this request.',
  });
  expect(phone.archive.message(overHttp.id)).toMatchObject({
    status: 'failed',
    accepted: false,
    error: 'Invalid request data or contract version.',
  });
  expect(server.dispatched).toEqual([]);
});

test('a receipt the server no longer recognizes settles the saved reply without retrying', async () => {
  const phone = openPhone(server);
  const chat = createChat(phone, 'kimi');
  phone.network.respond = (method, path) =>
    method === 'POST' && path.endsWith('/ack') ? 404 : null;
  const reply = phone.session.send(chat.id, 'Question', []);
  server.providers.script(reply.id).text('Kept').end();
  await settled(phone, reply.id);
  expect(phone.archive.message(reply.id)).toMatchObject({
    status: 'completed',
    text: 'Kept',
    acknowledged: true,
  });
  expect(
    phone.network.requests.filter(
      request => request === `POST /v1/jobs/${reply.id}/ack`,
    ),
  ).toHaveLength(1);
});
