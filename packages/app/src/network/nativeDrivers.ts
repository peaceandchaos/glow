import { NitroModules, type HybridObject } from 'react-native-nitro-modules';
import { TextDecoder } from 'react-native-nitro-text-decoder';
import { createWebSocket } from 'react-native-nitro-websockets';
import type {
  ClientDrivers,
  ClientReader,
  ClientResponse,
  ClientSocket,
} from './client';

// The subset of react-native-nitro-fetch's NitroCronet spec this binding uses.
// The package does not export it, and its public fetch() records headers and
// bodies in NetworkInspector.
type Native = { ios: 'swift'; android: 'kotlin' };
type ResponseInfo = { httpStatusCode: number };
interface NativeRequest extends HybridObject<Native> {
  start(): void;
  cancel(): void;
}
interface NativeRequestBuilder extends HybridObject<Native> {
  setHttpMethod(method: string): void;
  addHeader(name: string, value: string): void;
  setUploadBody(body: string): void;
  disableCache(): void;
  onRedirectReceived(
    callback: (info: ResponseInfo, location: string) => void,
  ): void;
  onResponseStarted(callback: (info: ResponseInfo) => void): void;
  onReadCompleted(
    callback: (info: ResponseInfo, buffer: ArrayBuffer, length: number) => void,
  ): void;
  onSucceeded(callback: (info: ResponseInfo) => void): void;
  onFailed(
    callback: (
      info: ResponseInfo | undefined,
      error: { message: string },
    ) => void,
  ): void;
  onCanceled(callback: (info: ResponseInfo | undefined) => void): void;
  build(): NativeRequest;
}
interface NativeStreamClient extends HybridObject<Native> {
  newUrlRequestBuilder(url: string): NativeRequestBuilder;
}

let streamClient: NativeStreamClient | null = null;

function abortError(): Error {
  const error = new Error('Reader detached.');
  error.name = 'AbortError';
  return error;
}

type Read = { done: boolean; value?: Uint8Array };
type Waiter = { resolve: (read: Read) => void; reject: (error: Error) => void };

// One native request. Every native callback and JS command moves it forward
// through awaiting-headers -> body -> ended, and nothing happens after ended.
class Exchange implements ClientReader {
  private headers: {
    resolve: (response: ClientResponse) => void;
    reject: (error: Error) => void;
  } | null;
  private ended: { error: Error | null } | null = null;
  private readonly chunks: Uint8Array[] = [];
  private waiter: Waiter | null = null;
  private readonly request: NativeRequest;

  constructor(
    builder: NativeRequestBuilder,
    private readonly signal: AbortSignal | null | undefined,
    resolve: (response: ClientResponse) => void,
    reject: (error: Error) => void,
  ) {
    this.headers = { resolve, reject };
    builder.onRedirectReceived(() =>
      this.close(
        new TypeError('The server redirected this request; it was refused.'),
      ),
    );
    builder.onResponseStarted(info => this.started(info.httpStatusCode));
    builder.onReadCompleted((_info, buffer, length) =>
      this.received(new Uint8Array(buffer, 0, length)),
    );
    builder.onSucceeded(() => this.end(null));
    builder.onFailed((_info, error) =>
      this.end(new TypeError(`Network request failed: ${error.message}`)),
    );
    builder.onCanceled(() => this.end(abortError()));
    this.request = builder.build();
    signal?.addEventListener('abort', this.abort, { once: true });
    this.request.start();
  }

  private readonly abort = () => this.close(abortError());

  private close(error: Error | null): void {
    if (this.ended) return;
    this.chunks.length = 0;
    this.end(error);
    this.request.cancel();
  }

  private started(status: number): void {
    const headers = this.headers;
    if (!headers) return;
    this.headers = null;
    headers.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => this.text(),
      body: { getReader: () => this },
    });
  }

  private received(chunk: Uint8Array): void {
    if (this.ended) return;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter.resolve({ done: false, value: chunk });
    else this.chunks.push(chunk);
  }

  private end(error: Error | null): void {
    if (this.ended) return;
    this.ended = { error };
    this.signal?.removeEventListener('abort', this.abort);
    const headers = this.headers;
    this.headers = null;
    headers?.reject(error ?? new TypeError('The response had no headers.'));
    const waiter = this.waiter;
    this.waiter = null;
    if (!waiter) return;
    if (error) waiter.reject(error);
    else waiter.resolve({ done: true });
  }

  read(): Promise<Read> {
    const value = this.chunks.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.ended)
      return this.ended.error
        ? Promise.reject(this.ended.error)
        : Promise.resolve({ done: true });
    if (this.waiter)
      return Promise.reject(new TypeError('A read is already pending.'));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  cancel(): Promise<void> {
    this.close(null);
    return Promise.resolve();
  }

  releaseLock(): void {}

  private async text(): Promise<string> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    for (;;) {
      const chunk = await this.read();
      if (chunk.done) return text + decoder.decode();
      text += decoder.decode(chunk.value, { stream: true });
    }
  }
}

function nativeFetch(
  url: string,
  init: RequestInit & { stream?: boolean },
): Promise<ClientResponse> {
  const { signal, headers, body } = init;
  if (signal?.aborted) return Promise.reject(abortError());
  if (
    init.redirect !== 'error' ||
    Array.isArray(headers) ||
    headers instanceof Headers ||
    (body !== undefined && body !== null && typeof body !== 'string')
  )
    return Promise.reject(
      new TypeError(
        'The native driver needs redirect:"error", plain headers, and a text body.',
      ),
    );
  streamClient ??=
    NitroModules.createHybridObject<NativeStreamClient>('NitroCronet');
  const builder = streamClient.newUrlRequestBuilder(url);
  builder.setHttpMethod(init.method ?? 'GET');
  for (const [name, value] of Object.entries(headers ?? {}))
    builder.addHeader(name, value);
  if (typeof body === 'string') builder.setUploadBody(body);
  builder.disableCache();
  return new Promise<ClientResponse>((resolve, reject) => {
    new Exchange(builder, signal, resolve, reject);
  });
}

// Uses the Nitro WebSocket object directly: the NitroWebSocket wrapper records
// connection headers, including the device credential, in NetworkInspector.
function nativeSocket(
  url: string,
  headers: Record<string, string>,
): ClientSocket {
  const socket = createWebSocket();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let onmessage: ClientSocket['onmessage'] = null;
  let onerror: ClientSocket['onerror'] = null;
  let onclose: ClientSocket['onclose'] = null;
  const client: ClientSocket = {
    get readyState() {
      return socket.readyState;
    },
    get onopen() {
      return socket.onOpen ?? null;
    },
    set onopen(handler) {
      socket.onOpen = handler ?? undefined;
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(handler) {
      onmessage = handler;
      socket.onMessage = handler
        ? event => {
            let data: string;
            try {
              data = decoder.decode(event.data);
            } catch {
              onerror?.('The server sent a message that is not UTF-8 text.');
              return;
            }
            handler({ data });
          }
        : undefined;
    },
    get onclose() {
      return onclose;
    },
    set onclose(handler) {
      onclose = handler;
      socket.onClose = handler ?? undefined;
    },
    get onerror() {
      return onerror;
    },
    set onerror(handler) {
      onerror = handler;
      socket.onError = handler ?? undefined;
    },
    send: data => socket.send(data),
    close: (code = 1000, reason = '') => socket.close(code, reason),
  };
  socket.connect(url, [], headers);
  return client;
}

export const nativeDrivers: ClientDrivers = {
  fetch: nativeFetch,
  socket: nativeSocket,
  decoder: () => new TextDecoder('utf-8', { fatal: true }),
};
