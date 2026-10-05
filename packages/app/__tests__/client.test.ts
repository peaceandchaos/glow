import { TransportError } from '../src/network/transport';
import {
  decodeJson,
  serverMessageSchema,
  socketCommandSchema,
  type AttemptSnapshot,
  type Picker,
  type ServerMessage,
  type Submission,
} from '../../../shared/contracts';
import {
  ServerTransport,
  validateServerAddress,
  type ClientDrivers,
  type ClientReader,
  type ClientResponse,
  type ClientSocket,
} from '../src/network/client';

const attemptId = '00000000-0000-4000-8000-000000000001';
const otherAttempt = '00000000-0000-4000-8000-000000000002';
const chatId = '00000000-0000-4000-8000-000000000003';
const pathId = '00000000-0000-4000-8000-000000000004';
const userTurnId = '00000000-0000-4000-8000-000000000005';
const deviceCredential = 'test-fixture-identity';

function input(picker: Picker = 'kimi', id = attemptId): Submission {
  return {
    version: 1,
    attemptId: id,
    chatId,
    pathId,
    userTurnId,
    picker,
    retryModel: null,
    checkpoints: [],
    history: [
      {
        id: userTurnId,
        parentId: null,
        role: 'user',
        text: 'Hello',
        images: [],
        complete: true,
      },
    ],
  };
}

function snapshot(id = attemptId, completed = true): AttemptSnapshot {
  return {
    version: 1,
    attemptId: id,
    chatId,
    pathId,
    userTurnId,
    sequence: completed ? 2 : 0,
    status: completed ? 'completed' : 'accepted',
    actualModel: 'kimi',
    text: completed ? 'Saved answer' : '',
    reasoning: '',
    error: null,
    checkpoint: null,
    cancelRequested: false,
    delivered: false,
  };
}

class TestSocket implements ClientSocket {
  readyState = 'CONNECTING';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((error: string) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.readyState = 'CLOSED';
    this.onclose?.({ code });
  }
  open(): void {
    this.readyState = 'OPEN';
    this.onopen?.();
  }
  emit(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

class ChunkReader implements ClientReader {
  cancelled = false;
  released = false;
  private offset = 0;
  constructor(
    private readonly raw: string,
    private readonly split: number,
  ) {}
  read() {
    if (this.cancelled || this.offset >= this.raw.length)
      return Promise.resolve({ done: true });
    const text = this.raw.slice(this.offset, this.offset + this.split);
    this.offset += text.length;
    return Promise.resolve({
      done: false,
      value: Uint8Array.from(text, char => char.charCodeAt(0)),
    });
  }
  cancel() {
    this.cancelled = true;
    return Promise.resolve();
  }
  releaseLock() {
    this.released = true;
  }
}

function response(text: string, status = 200): ClientResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    text: () => Promise.resolve(text),
  };
}

function streamed(messages: ServerMessage[], split = 13): ClientResponse {
  const reader = new ChunkReader(
    messages
      .map(message => `data: ${JSON.stringify(message)}\r\n\r\n`)
      .join(''),
    split,
  );
  return { ...response(''), body: { getReader: () => reader } };
}

function setup() {
  const calls: Array<{
    url: string;
    init: RequestInit & { stream?: boolean };
  }> = [];
  const sockets: TestSocket[] = [];
  const socketHeaders: Array<Record<string, string>> = [];
  let reply = streamed([{ kind: 'accepted', snapshot: snapshot() }]);
  const drivers: ClientDrivers = {
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(reply);
    },
    socket: (_url, headers) => {
      const socket = new TestSocket();
      sockets.push(socket);
      socketHeaders.push(headers);
      return socket;
    },
    decoder: () => ({
      decode: bytes => {
        if (!bytes) return '';
        const data = new Uint8Array(
          ArrayBuffer.isView(bytes) ? bytes.buffer : bytes,
          ArrayBuffer.isView(bytes) ? bytes.byteOffset : 0,
          bytes.byteLength,
        );
        let text = '';
        for (let offset = 0; offset < data.length; offset += 8192)
          text += String.fromCharCode(...data.subarray(offset, offset + 8192));
        return text;
      },
    }),
  };
  // Fixture streams use ASCII; shared provider tests cover UTF-8 decoding boundaries.
  return {
    calls,
    sockets,
    socketHeaders,
    drivers,
    transport: new ServerTransport(
      'https://chat.example',
      deviceCredential,
      drivers,
    ),
    reply: (next: ClientResponse) => {
      reply = next;
    },
  };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test.each(['kimi', 'deepseek'] as const)(
  'manual %s uses one HTTP submission with streamed, authenticated delivery',
  async picker => {
    const fixture = setup();
    const received: ServerMessage[] = [];
    await fixture.transport.submit(
      input(picker),
      value => received.push(value),
      new AbortController().signal,
    );
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      url: 'https://chat.example/v1/chat',
      init: {
        method: 'POST',
        stream: true,
        redirect: 'error',
        headers: { 'X-Device-Id': deviceCredential },
      },
    });
    expect(fixture.calls[0].url).not.toContain(deviceCredential);
    expect(fixture.sockets).toHaveLength(0);
    expect(received).toEqual([{ kind: 'accepted', snapshot: snapshot() }]);
  },
);

test.each(['auto', 'gpt-6.1-sol', 'gpt-6-astra'] as const)(
  '%s sends through the shared socket without a separate selection request',
  async picker => {
    const fixture = setup();
    const promise = fixture.transport.submit(
      input(picker),
      () => undefined,
      new AbortController().signal,
    );
    fixture.sockets[0].open();
    await settle();
    expect(fixture.sockets[0].sent).toHaveLength(1);
    expect(decodeJson(socketCommandSchema, fixture.sockets[0].sent[0])).toEqual(
      { kind: 'submit', submission: input(picker) },
    );
    fixture.sockets[0].emit({ kind: 'accepted', snapshot: snapshot() });
    await promise;
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.socketHeaders).toEqual([
      { 'X-Device-Id': deviceCredential },
    ]);
    fixture.transport.disconnect();
  },
);

test('parallel socket replies stay isolated and detaching one never sends Stop', async () => {
  const fixture = setup();
  const firstAbort = new AbortController();
  const first: ServerMessage[] = [];
  const second: ServerMessage[] = [];
  const a = fixture.transport.submit(
    input('auto'),
    value => first.push(value),
    firstAbort.signal,
  );
  const b = fixture.transport.submit(
    input('gpt-6.1-sol', otherAttempt),
    value => second.push(value),
    new AbortController().signal,
  );
  fixture.sockets[0].open();
  await settle();
  expect(fixture.sockets).toHaveLength(1);
  firstAbort.abort();
  fixture.sockets[0].emit({ kind: 'accepted', snapshot: snapshot() });
  fixture.sockets[0].emit({
    kind: 'accepted',
    snapshot: snapshot(otherAttempt),
  });
  await Promise.all([a, b]);
  expect(first).toEqual([]);
  expect(second).toEqual([
    { kind: 'accepted', snapshot: snapshot(otherAttempt) },
  ]);
  expect(fixture.calls).toEqual([]);
  expect(
    fixture.sockets[0].sent.map(
      raw => decodeJson(socketCommandSchema, raw).kind,
    ),
  ).toEqual(['submit', 'submit']);
  fixture.transport.disconnect();
});

test('a lost socket rejects delivery without resending the submission', async () => {
  const fixture = setup();
  const pending = fixture.transport.submit(
    input('auto'),
    () => undefined,
    new AbortController().signal,
  );
  fixture.sockets[0].open();
  await settle();
  fixture.sockets[0].close(1006);
  await expect(pending).rejects.toMatchObject({ status: 503 });
  expect(fixture.sockets[0].sent).toHaveLength(1);
});

test('a socket error naming no attempt fails open readers as a connection loss, while a named refusal keeps its status', async () => {
  const fixture = setup();
  const first = fixture.transport.submit(
    input('auto'),
    () => undefined,
    new AbortController().signal,
  );
  const second = fixture.transport.submit(
    input('gpt-6.1-sol', otherAttempt),
    () => undefined,
    new AbortController().signal,
  );
  fixture.sockets[0].open();
  await settle();
  fixture.sockets[0].emit({
    kind: 'error',
    attemptId: otherAttempt,
    status: 409,
    message: 'This conversation path already has a reply in progress.',
  });
  await expect(second).rejects.toMatchObject({
    status: 409,
    message: 'This conversation path already has a reply in progress.',
  });
  fixture.sockets[0].emit({
    kind: 'error',
    attemptId: null,
    status: 400,
    message: 'Invalid request data or contract version.',
  });
  await expect(first).rejects.toMatchObject({
    status: 503,
    message: 'Connection failed.',
  });
  fixture.transport.disconnect();
});

test('a second reader for the same attempt is refused locally, not as a server refusal', async () => {
  const fixture = setup();
  const first = fixture.transport.submit(
    input('auto'),
    () => undefined,
    new AbortController().signal,
  );
  fixture.sockets[0].open();
  await settle();
  const second = await fixture.transport
    .submit(input('auto'), () => undefined, new AbortController().signal)
    .then(
      () => null,
      (error: Error) => error,
    );
  expect(second?.message).toBe('This reply already has an attached reader.');
  expect(second).not.toBeInstanceOf(TransportError);
  fixture.transport.disconnect();
  await first;
});

test('recovery reads an existing attempt and never submits a new generation', async () => {
  const fixture = setup();
  const received: ServerMessage[] = [];
  await fixture.transport.watch(
    snapshot(attemptId, false),
    value => received.push(value),
    new AbortController().signal,
  );
  expect(fixture.calls[0]).toMatchObject({
    url: `https://chat.example/v1/jobs/${attemptId}/events`,
    init: { method: 'GET', stream: true },
  });
  expect(received).toEqual([{ kind: 'accepted', snapshot: snapshot() }]);
  expect(fixture.sockets).toEqual([]);
});

test('large HTTP inputs upload acknowledged parts before one commit', async () => {
  const fixture = setup();
  const submission = input();
  submission.history[0].text = 'x'.repeat(650_000);
  const parts: string[] = [];
  const kinds: string[] = [];
  fixture.drivers.fetch = (_url, init) => {
    if (typeof init.body !== 'string')
      throw new Error('Expected a JSON string.');
    const command = decodeJson(socketCommandSchema, init.body);
    kinds.push(command.kind);
    if (command.kind === 'stage') {
      parts.push(command.text);
      return Promise.resolve(
        response(
          JSON.stringify({ kind: 'staged', attemptId, index: command.index }),
        ),
      );
    }
    return Promise.resolve(
      streamed([{ kind: 'accepted', snapshot: snapshot() }]),
    );
  };
  await fixture.transport.submit(
    submission,
    () => undefined,
    new AbortController().signal,
  );
  expect(kinds).toEqual(['stage', 'stage', 'stage', 'commit']);
  expect(parts.join('')).toBe(JSON.stringify(submission));
});

test('explicit Stop is separate from reader abort, and 204 handles cancellation before acceptance', async () => {
  const fixture = setup();
  fixture.reply(response('', 204));
  expect(
    await fixture.transport.stop(attemptId, new AbortController().signal),
  ).toBeNull();
  expect(fixture.calls[0]).toMatchObject({
    url: `https://chat.example/v1/jobs/${attemptId}/stop`,
    init: { method: 'POST' },
  });
});

test('401 and stream errors keep their status and do not trigger retry', async () => {
  const fixture = setup();
  fixture.reply(response('{"error":"Unauthorized"}', 401));
  await expect(
    fixture.transport.get(attemptId, new AbortController().signal),
  ).rejects.toMatchObject({ status: 401 });
  fixture.reply(
    streamed([
      { kind: 'error', attemptId, message: 'Invalid input', status: 400 },
    ]),
  );
  await expect(
    fixture.transport.submit(
      input(),
      () => undefined,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(fixture.calls).toHaveLength(2);
});

test('malformed SSE is rejected and the reader is released', async () => {
  const fixture = setup();
  const reader = new ChunkReader(
    'data: {"kind":"accepted","snapshot":{}}\n\n',
    1,
  );
  fixture.reply({ ...response(''), body: { getReader: () => reader } });
  await expect(
    fixture.transport.submit(
      input(),
      () => undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(reader.cancelled).toBe(true);
  expect(reader.released).toBe(true);
});

test('server-address validation requires TLS except explicit private development addresses', () => {
  expect(validateServerAddress('https://chat.example/', false)).toBe(
    'https://chat.example',
  );
  expect(validateServerAddress('http://192.168.1.5:3000', true)).toBe(
    'http://192.168.1.5:3000',
  );
  for (const address of [
    'http://chat.example',
    'https://user:pass@chat.example',
    'https://chat.example/path',
    'https://chat.example?credential=example',
  ])
    expect(() => validateServerAddress(address, false)).toThrow();
});

test('ranking rejects IDs outside the provided title candidates', async () => {
  const fixture = setup();
  fixture.reply(response(JSON.stringify({ ids: [otherAttempt] })));
  await expect(
    fixture.transport.rank(
      { query: 'hello', candidates: [{ id: chatId, title: 'Hello' }] },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Invalid title ranking');
});

test('server event runtime validation rejects invalid HTTP status values', () => {
  expect(() =>
    decodeJson(
      serverMessageSchema,
      JSON.stringify({
        kind: 'error',
        attemptId,
        message: 'invalid',
        status: 200,
      }),
    ),
  ).toThrow();
});

test('socket context upload waits for each matching acknowledgement before committing', async () => {
  const fixture = setup();
  const submission = input('auto');
  submission.history[0].text = 'x'.repeat(340_000);
  const pending = fixture.transport.submit(
    submission,
    () => undefined,
    new AbortController().signal,
  );
  fixture.sockets[0].open();
  await settle();
  expect(fixture.sockets[0].sent).toHaveLength(1);
  fixture.sockets[0].emit({ kind: 'staged', attemptId, index: 1 });
  await settle();
  expect(fixture.sockets[0].sent).toHaveLength(1);
  fixture.sockets[0].emit({ kind: 'staged', attemptId, index: 0 });
  await settle();
  expect(fixture.sockets[0].sent).toHaveLength(2);
  fixture.sockets[0].emit({ kind: 'staged', attemptId, index: 1 });
  await settle();
  expect(
    fixture.sockets[0].sent.map(
      raw => decodeJson(socketCommandSchema, raw).kind,
    ),
  ).toEqual(['stage', 'stage', 'commit']);
  fixture.sockets[0].emit({ kind: 'accepted', snapshot: snapshot() });
  await pending;
  fixture.transport.disconnect();
});

test('detaching during socket context upload cannot send the final commit', async () => {
  const fixture = setup();
  const submission = input('auto');
  submission.history[0].text = 'x'.repeat(340_000);
  const controller = new AbortController();
  const pending = fixture.transport.submit(
    submission,
    () => undefined,
    controller.signal,
  );
  fixture.sockets[0].open();
  await settle();
  controller.abort();
  await pending;
  fixture.sockets[0].emit({ kind: 'staged', attemptId, index: 0 });
  await settle();
  expect(fixture.sockets[0].sent).toHaveLength(1);
  fixture.transport.disconnect();
});

test('a reader abort releases HTTP delivery without requesting job cancellation', async () => {
  const fixture = setup();
  const reader = new ChunkReader(
    `data: ${JSON.stringify({ kind: 'accepted', snapshot: snapshot(attemptId, false) })}\n\n`,
    5000,
  );
  fixture.reply({ ...response(''), body: { getReader: () => reader } });
  const controller = new AbortController();
  await fixture.transport.watch(
    snapshot(attemptId, false),
    () => controller.abort(),
    controller.signal,
  );
  expect(reader.cancelled).toBe(true);
  expect(reader.released).toBe(true);
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0].url).toContain('/events');
});

test('a recovered snapshot can exceed the provider token-event size limit', async () => {
  const fixture = setup();
  const result = { ...snapshot(), text: 'x'.repeat(1_100_000) };
  fixture.reply(streamed([{ kind: 'accepted', snapshot: result }], 1_049_000));
  const received: ServerMessage[] = [];
  await fixture.transport.watch(
    result,
    value => received.push(value),
    new AbortController().signal,
  );
  expect(received).toEqual([{ kind: 'accepted', snapshot: result }]);
});

test('delivery cannot attach another attempt result to the requested reader', async () => {
  const fixture = setup();
  fixture.reply(
    streamed([{ kind: 'accepted', snapshot: snapshot(otherAttempt) }]),
  );
  await expect(
    fixture.transport.watch(
      snapshot(),
      () => undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow('Reply identity mismatch');
});

test('a late close from an old socket cannot detach a replacement connection', async () => {
  const fixture = setup();
  const first = fixture.transport.submit(
    input('auto'),
    () => undefined,
    new AbortController().signal,
  );
  const original = fixture.sockets[0];
  original.open();
  await settle();
  const lateClose = original.onclose;
  original.close(1006);
  await expect(first).rejects.toMatchObject({ status: 503 });
  const received: ServerMessage[] = [];
  const replacement = fixture.transport.submit(
    input('auto'),
    value => received.push(value),
    new AbortController().signal,
  );
  fixture.sockets[1].open();
  await settle();
  lateClose?.({ code: 1006 });
  fixture.sockets[1].emit({ kind: 'accepted', snapshot: snapshot() });
  await replacement;
  expect(received).toEqual([{ kind: 'accepted', snapshot: snapshot() }]);
  fixture.transport.disconnect();
});
