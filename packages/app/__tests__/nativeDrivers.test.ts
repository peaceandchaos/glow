// Contract checks for the native drivers against fake Nitro objects. Native
// behavior is verified on a simulator by tools/native-transport/run.mjs.
import type { ClientReader } from '../src/network/client';
import { nativeDrivers } from '../src/network/nativeDrivers';

type Info = { httpStatusCode: number };
type Listeners = {
  redirect: (info: Info, location: string) => void;
  started: (info: Info) => void;
  read: (info: Info, buffer: ArrayBuffer, length: number) => void;
  succeeded: (info: Info) => void;
  failed: (info: Info | undefined, error: { message: string }) => void;
  canceled: (info: Info | undefined) => void;
};
type Exchange = {
  url: string;
  listeners: Partial<Listeners>;
  cancels: number;
  method: string | null;
  headers: string[][];
  body: string | null;
  cached: boolean;
};
type FakeSocket = {
  connected: {
    url: string;
    protocols: string[];
    headers: Record<string, string>;
  } | null;
  sent: string[];
  closed: Array<[number, string]>;
  readyState: string;
  onOpen?: () => void;
  onMessage?: (event: { data: ArrayBuffer; isBinary: boolean }) => void;
  onClose?: (event: { code: number; reason: string }) => void;
  onError?: (error: string) => void;
};

const { getEventListeners } = jest.requireActual<{
  getEventListeners: (target: EventTarget, type: string) => unknown[];
}>('node:events');

const mockExchanges: Exchange[] = [];
const mockSockets: FakeSocket[] = [];

jest.mock('react-native-nitro-modules', () => ({
  NitroModules: {
    createHybridObject: () => ({
      newUrlRequestBuilder: (url: string) => {
        const exchange: Exchange = {
          url,
          listeners: {},
          cancels: 0,
          method: null,
          headers: [],
          body: null,
          cached: true,
        };
        mockExchanges.push(exchange);
        const on = (key: keyof Listeners) => (listener: never) => {
          exchange.listeners[key] = listener;
        };
        return {
          setHttpMethod: (method: string) => {
            exchange.method = method;
          },
          addHeader: (name: string, value: string) =>
            exchange.headers.push([name, value]),
          setUploadBody: (body: string) => {
            exchange.body = body;
          },
          disableCache: () => {
            exchange.cached = false;
          },
          onRedirectReceived: on('redirect'),
          onResponseStarted: on('started'),
          onReadCompleted: on('read'),
          onSucceeded: on('succeeded'),
          onFailed: on('failed'),
          onCanceled: on('canceled'),
          build: () => ({
            start: () => undefined,
            cancel: () => {
              exchange.cancels += 1;
            },
          }),
        };
      },
    }),
  },
}));
jest.mock('react-native-nitro-text-decoder', () => ({
  TextDecoder: globalThis.TextDecoder,
}));
jest.mock('react-native-nitro-websockets', () => ({
  createWebSocket: () => {
    const socket: FakeSocket = {
      connected: null,
      sent: [],
      closed: [],
      readyState: 'CONNECTING',
    };
    mockSockets.push(socket);
    return Object.assign(socket, {
      connect: (
        url: string,
        protocols: string[],
        headers: Record<string, string>,
      ) => {
        socket.connected = { url, protocols, headers };
      },
      send: (data: string) => socket.sent.push(data),
      close: (code: number, reason: string) =>
        socket.closed.push([code, reason]),
    });
  },
}));

const ok = { httpStatusCode: 200 };
const url = 'http://localhost:1/v1/jobs/x';

function start(signal = new AbortController().signal) {
  const response = nativeDrivers.fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal,
    headers: { 'X-Device-Id': 'fixture' },
  });
  const exchange = mockExchanges.at(-1);
  if (!exchange) throw new Error('No native request was built.');
  return { response, exchange };
}

// A missing native listener fails here instead of leaving a promise pending.
function fire<Key extends keyof Listeners>(
  exchange: Exchange,
  key: Key,
): Listeners[Key] {
  const listener = exchange.listeners[key];
  if (!listener) throw new Error(`The driver registered no ${key} listener.`);
  return listener;
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

async function reader(
  response: ReturnType<typeof start>['response'],
): Promise<ClientReader> {
  const body = (await response).body;
  if (!body) throw new Error('Missing body.');
  return body.getReader();
}

beforeEach(() => {
  mockExchanges.length = 0;
  mockSockets.length = 0;
});

test('a request reaches native as given, with caching off', () => {
  void nativeDrivers.fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'X-Device-Id': 'fixture' },
    body: '{"kind":"submit"}',
  });
  expect(mockExchanges).toEqual([
    {
      url,
      listeners: expect.any(Object),
      cancels: 0,
      method: 'POST',
      headers: [['X-Device-Id', 'fixture']],
      body: '{"kind":"submit"}',
      cached: false,
    },
  ]);
});

test('abort before headers cancels the native request once and ignores late callbacks', async () => {
  const controller = new AbortController();
  const { response, exchange } = start(controller.signal);
  controller.abort();
  await expect(response).rejects.toMatchObject({ name: 'AbortError' });
  fire(exchange, 'canceled')(undefined);
  fire(exchange, 'started')(ok);
  fire(exchange, 'read')(ok, bytes('late'), 4);
  expect(exchange.cancels).toBe(1);
});

test('abort during the body rejects the pending read, cancels native, and drops late chunks', async () => {
  const controller = new AbortController();
  const { response, exchange } = start(controller.signal);
  fire(exchange, 'started')(ok);
  const body = await reader(response);
  const pending = body.read();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  fire(exchange, 'read')(ok, bytes('late'), 4);
  fire(exchange, 'succeeded')(ok);
  await expect(body.read()).rejects.toMatchObject({ name: 'AbortError' });
  expect(exchange.cancels).toBe(1);
});

test('abort discards chunks that were queued but not yet read', async () => {
  const controller = new AbortController();
  const { response, exchange } = start(controller.signal);
  fire(exchange, 'started')(ok);
  fire(exchange, 'read')(ok, bytes('data: queued\n\n'), 14);
  const body = await reader(response);
  controller.abort();
  await expect(body.read()).rejects.toMatchObject({ name: 'AbortError' });
});

test('a second concurrent read is refused without disturbing the first', async () => {
  const { response, exchange } = start();
  fire(exchange, 'started')(ok);
  const body = await reader(response);
  const first = body.read();
  await expect(body.read()).rejects.toThrow('A read is already pending.');
  fire(exchange, 'read')(ok, bytes('one'), 3);
  const chunk = await first;
  expect(new TextDecoder().decode(chunk.value)).toBe('one');
});

test('reader cancel ends a pending read as done and cancels native once', async () => {
  const { response, exchange } = start();
  fire(exchange, 'started')(ok);
  const body = await reader(response);
  const pending = body.read();
  await body.cancel();
  await body.cancel();
  await expect(pending).resolves.toEqual({ done: true });
  expect(exchange.cancels).toBe(1);
});

test('a redirect is refused and the native request is cancelled', async () => {
  const { response, exchange } = start();
  fire(exchange, 'redirect')({ httpStatusCode: 307 }, 'http://elsewhere/');
  await expect(response).rejects.toThrow('redirected');
  expect(exchange.cancels).toBe(1);
});

test('queued chunks drain before a native failure surfaces', async () => {
  const { response, exchange } = start();
  fire(exchange, 'started')(ok);
  fire(exchange, 'read')(ok, bytes('data: 1\n\n'), 9);
  fire(exchange, 'failed')(ok, { message: 'The network connection was lost.' });
  const body = await reader(response);
  const first = await body.read();
  expect(new TextDecoder().decode(first.value)).toBe('data: 1\n\n');
  await expect(body.read()).rejects.toThrow('The network connection was lost.');
});

test('text() reconstructs UTF-8 split across native chunks', async () => {
  const { response, exchange } = start();
  fire(exchange, 'started')({ httpStatusCode: 429 });
  const encoded = new TextEncoder().encode('{"error":"Grüße 🦋"}');
  for (let offset = 0; offset < encoded.length; offset += 3) {
    const chunk = encoded.slice(offset, offset + 3);
    fire(exchange, 'read')(ok, chunk.buffer, chunk.length);
  }
  fire(exchange, 'succeeded')(ok);
  const result = await response;
  expect(result.status).toBe(429);
  expect(result.ok).toBe(false);
  await expect(result.text()).resolves.toBe('{"error":"Grüße 🦋"}');
});

test('text() rejects invalid UTF-8 and a truncated final character', async () => {
  for (const body of [
    [0x7b, 0xff, 0x7d],
    [0x7b, 0xf0, 0x9f, 0xa6],
  ]) {
    const { response, exchange } = start();
    fire(exchange, 'started')(ok);
    fire(exchange, 'read')(ok, new Uint8Array(body).buffer, body.length);
    fire(exchange, 'succeeded')(ok);
    await expect((await response).text()).rejects.toMatchObject({
      name: 'TypeError',
    });
  }
});

test('a finished request leaves no listener on the caller signal', async () => {
  const controller = new AbortController();
  const { response, exchange } = start(controller.signal);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
  fire(exchange, 'started')(ok);
  fire(exchange, 'succeeded')(ok);
  await (await response).text();
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test('a request that could follow redirects or is already aborted never reaches native', async () => {
  const settled = Promise.allSettled([
    nativeDrivers.fetch(url, { redirect: 'follow' }),
    nativeDrivers.fetch(url, {
      redirect: 'error',
      signal: AbortSignal.abort(),
    }),
  ]);
  expect(mockExchanges).toHaveLength(0);
  expect(await settled).toMatchObject([
    {
      status: 'rejected',
      reason: { message: expect.stringContaining('redirect:"error"') },
    },
    { status: 'rejected', reason: { name: 'AbortError' } },
  ]);
});

function socket() {
  const client = nativeDrivers.socket('ws://localhost:1/v1/responses', {
    'X-Device-Id': 'fixture',
  });
  const native = mockSockets.at(-1);
  if (!native) throw new Error('No native socket was created.');
  return { client, native };
}

test('the socket connects to the requested URL with the credential header', () => {
  const { native } = socket();
  expect(native.connected).toEqual({
    url: 'ws://localhost:1/v1/responses',
    protocols: [],
    headers: { 'X-Device-Id': 'fixture' },
  });
});

test('socket messages arrive as decoded text, and invalid UTF-8 becomes an error', () => {
  const { client, native } = socket();
  const messages: string[] = [];
  const errors: string[] = [];
  client.onmessage = event => messages.push(event.data);
  client.onerror = error => errors.push(error);
  native.onMessage?.({ data: bytes('{"kind":"détaché"}'), isBinary: false });
  native.onMessage?.({ data: new Uint8Array([0xc3]).buffer, isBinary: false });
  expect(messages).toEqual(['{"kind":"détaché"}']);
  expect(errors).toEqual(['The server sent a message that is not UTF-8 text.']);
});

test('socket state, sends, closes, and handler removal pass through', () => {
  const { client, native } = socket();
  const closes: number[] = [];
  client.onclose = event => closes.push(event.code);
  native.readyState = 'OPEN';
  expect(client.readyState).toBe('OPEN');
  client.send('{"kind":"attach"}');
  client.close();
  client.close(1008, 'Unauthorized');
  native.onClose?.({ code: 1006, reason: '' });
  client.onclose = null;
  client.onmessage = null;
  expect(native.sent).toEqual(['{"kind":"attach"}']);
  expect(native.closed).toEqual([
    [1000, ''],
    [1008, 'Unauthorized'],
  ]);
  expect(closes).toEqual([1006]);
  expect(native.onClose).toBeUndefined();
  expect(native.onMessage).toBeUndefined();
});
