import { z } from 'zod';
import {
  attemptSnapshotSchema,
  decodeJson,
  idSchema,
  isTerminal,
  serverMessageSchema,
  submissionCommands,
  type AttemptSnapshot,
  type SearchRequest,
  type ServerMessage,
  type SocketCommand,
  type Submission,
} from '../../../../shared/contracts';
import { SseDecoder } from '../../../../shared/provider-events';
import {
  ReaderConflict,
  TransportError,
  type ChatTransport,
  type Receive,
} from './transport';

export interface ClientSocket {
  readonly readyState: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((error: string) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
interface StreamTextDecoder {
  decode(
    input?: ArrayBuffer | ArrayBufferView,
    options?: { stream?: boolean },
  ): string;
}
export interface ClientReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}
export interface ClientResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: { getReader(): ClientReader } | null;
}
export type ClientDrivers = {
  // The native binding must enforce redirect:'error' and abort the real request.
  fetch: (
    url: string,
    init: RequestInit & { stream?: boolean },
  ) => Promise<ClientResponse>;
  socket: (url: string, headers: Record<string, string>) => ClientSocket;
  decoder: () => StreamTextDecoder;
};
type Feed = {
  receive: Receive;
  finish: (error?: Error) => void;
  staged: ((index: number) => void) | null;
};
const errorSchema = z.object({ error: z.string() });
const rankSchema = z.strictObject({ ids: z.array(idSchema).max(20) });

export function validateServerAddress(
  raw: string,
  allowLocal: boolean,
): string {
  const url = new URL(raw.trim());
  const local =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    /^10\.\d+\.\d+\.\d+$/u.test(url.hostname) ||
    /^192\.168\.\d+\.\d+$/u.test(url.hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+$/u.test(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(allowLocal && local && url.protocol === 'http:'))
  )
    throw new Error(
      'Use an HTTPS server address without a path, password, or query.',
    );
  return url.origin;
}

function attemptOf(message: ServerMessage): string | null {
  if (message.kind === 'accepted') return message.snapshot.attemptId;
  if (message.kind === 'event') return message.event.attemptId;
  return message.attemptId;
}

function terminal(message: ServerMessage): boolean {
  return (
    (message.kind === 'accepted' && isTerminal(message.snapshot.status)) ||
    (message.kind === 'event' &&
      message.event.kind === 'snapshot' &&
      isTerminal(message.event.snapshot.status))
  );
}

export class ServerTransport implements ChatTransport {
  private readonly baseUrl: string;
  private socket: ClientSocket | null = null;
  private opening: Promise<ClientSocket> | null = null;
  private readonly feeds = new Map<string, Feed>();

  constructor(
    baseUrl: string,
    private readonly deviceId: string,
    private readonly drivers: ClientDrivers,
    allowLocal = false,
  ) {
    this.baseUrl = validateServerAddress(baseUrl, allowLocal);
  }

  private async request(
    path: string,
    signal: AbortSignal,
    method = 'GET',
    body?: string,
    stream = false,
  ): Promise<ClientResponse> {
    if (signal.aborted) throw new Error('Reader detached.');
    const response = await this.drivers.fetch(`${this.baseUrl}${path}`, {
      method,
      signal,
      stream,
      redirect: 'error',
      headers: {
        'X-Device-Id': this.deviceId,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) {
      let message = 'The server could not complete this request.';
      try {
        message = decodeJson(errorSchema, await response.text()).error;
      } catch {
        /* Use the fixed message for non-JSON infrastructure errors. */
      }
      throw new TransportError(response.status, message);
    }
    return response;
  }

  async get(id: string, signal: AbortSignal): Promise<AttemptSnapshot> {
    const response = await this.request(`/v1/jobs/${id}`, signal);
    return decodeJson(attemptSnapshotSchema, await response.text());
  }

  async stop(id: string, signal: AbortSignal): Promise<AttemptSnapshot | null> {
    const response = await this.request(`/v1/jobs/${id}/stop`, signal, 'POST');
    return response.status === 204
      ? null
      : decodeJson(attemptSnapshotSchema, await response.text());
  }

  async acknowledge(
    id: string,
    sequence: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.request(
      `/v1/jobs/${id}/ack`,
      signal,
      'POST',
      JSON.stringify({ sequence }),
    );
  }

  async deleteChat(id: string, signal: AbortSignal): Promise<void> {
    await this.request(`/v1/chats/${id}`, signal, 'DELETE');
  }

  async rank(input: SearchRequest, signal: AbortSignal): Promise<string[]> {
    const response = await this.request(
      '/v1/search',
      signal,
      'POST',
      JSON.stringify(input),
    );
    const ranked = decodeJson(rankSchema, await response.text()).ids;
    const candidates = new Set(input.candidates.map(candidate => candidate.id));
    if (
      new Set(ranked).size !== ranked.length ||
      ranked.some(id => !candidates.has(id))
    )
      throw new TransportError(502, 'Invalid title ranking.');
    return ranked;
  }

  async submit(
    input: Submission,
    receive: Receive,
    signal: AbortSignal,
  ): Promise<void> {
    const selected = input.retryModel ?? input.picker;
    if (selected !== 'kimi' && selected !== 'deepseek') {
      await this.socketFeed(
        input.attemptId,
        submissionCommands(input),
        receive,
        signal,
      );
      return;
    }
    for (const command of submissionCommands(input)) {
      const response = await this.request(
        '/v1/chat',
        signal,
        'POST',
        JSON.stringify(command),
        command.kind !== 'stage',
      );
      if (command.kind === 'stage') {
        const result = decodeJson(serverMessageSchema, await response.text());
        if (
          result.kind !== 'staged' ||
          result.attemptId !== input.attemptId ||
          result.index !== command.index
        )
          throw new TransportError(502, 'Context upload was not acknowledged.');
      } else await this.readStream(input.attemptId, response, receive, signal);
    }
  }

  async watch(
    snapshot: AttemptSnapshot,
    receive: Receive,
    signal: AbortSignal,
  ): Promise<void> {
    // Recovery can always use a detachable HTTP reader. GPT and Auto submission
    // still use the socket; this does not change the worker's provider transport.
    const response = await this.request(
      `/v1/jobs/${snapshot.attemptId}/events`,
      signal,
      'GET',
      undefined,
      true,
    );
    await this.readStream(snapshot.attemptId, response, receive, signal);
  }

  private async readStream(
    attemptId: string,
    response: ClientResponse,
    receive: Receive,
    signal: AbortSignal,
  ): Promise<void> {
    if (!response.body)
      throw new TransportError(502, 'The reply stream is missing.');
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    // Job snapshots can include a provider context checkpoint, beyond one token record.
    const sse = new SseDecoder(32_000_000);
    try {
      const decoder = this.drivers.decoder();
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (signal.aborted) return;
        if (!chunk.done && !chunk.value)
          throw new TransportError(
            502,
            'The reply stream returned an invalid chunk.',
          );
        const text = chunk.done
          ? decoder.decode()
          : decoder.decode(chunk.value, { stream: true });
        for (const raw of sse.push(text)) {
          const message = decodeJson(serverMessageSchema, raw);
          if (message.kind === 'error')
            throw new TransportError(message.status ?? 503, message.message);
          if (attemptOf(message) !== attemptId)
            throw new TransportError(502, 'Reply identity mismatch.');
          receive(message);
          if (terminal(message)) return;
        }
        if (chunk.done) {
          sse.finish();
          return;
        }
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private connect(): Promise<ClientSocket> {
    if (this.socket?.readyState === 'OPEN') return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    const socket = this.drivers.socket(
      `${this.baseUrl.replace(/^http/u, 'ws')}/v1/responses`,
      { 'X-Device-Id': this.deviceId },
    );
    this.socket = socket;
    this.opening = new Promise<ClientSocket>((resolve, reject) => {
      let opened = false;
      const timeout = setTimeout(
        () => fail(new Error('Connection timed out.')),
        15_000,
      );
      const fail = (error: Error) => {
        clearTimeout(timeout);
        if (this.socket === socket) {
          this.socket = null;
          this.opening = null;
          for (const feed of this.feeds.values()) feed.finish(error);
        }
        if (!opened) reject(error);
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      };
      socket.onopen = () => {
        if (this.socket !== socket) {
          fail(new Error('Reader detached.'));
          return;
        }
        opened = true;
        clearTimeout(timeout);
        this.opening = null;
        resolve(socket);
      };
      socket.onmessage = event => {
        try {
          this.route(decodeJson(serverMessageSchema, event.data));
        } catch {
          fail(
            new TransportError(
              502,
              'Invalid reply stream. Reconnect to recover it.',
            ),
          );
        }
      };
      socket.onclose = event =>
        fail(
          new TransportError(
            event.code === 1008 ? 401 : 503,
            'Connection closed.',
          ),
        );
      socket.onerror = () =>
        fail(new TransportError(503, 'Connection failed.'));
    });
    return this.opening;
  }

  private route(message: ServerMessage): void {
    const id = attemptOf(message);
    if (!id) {
      // An error naming no attempt refused some other frame, so it is not a
      // verdict on these replies. Readers treat it as a lost connection.
      if (message.kind === 'error')
        for (const feed of this.feeds.values())
          feed.finish(new TransportError(503, 'Connection failed.'));
      return;
    }
    const feed = this.feeds.get(id);
    if (!feed) return;
    if (message.kind === 'staged') {
      feed.staged?.(message.index);
      return;
    }
    if (message.kind === 'error') {
      feed.finish(new TransportError(message.status ?? 503, message.message));
      return;
    }
    try {
      feed.receive(message);
      if (terminal(message) || message.kind === 'detached') feed.finish();
    } catch (error) {
      feed.finish(
        error instanceof Error ? error : new Error('Reply delivery failed.'),
      );
    }
  }

  private async socketFeed(
    id: string,
    commands: Iterable<SocketCommand>,
    receive: Receive,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const socket = await this.connect();
    if (signal.aborted) return;
    if (this.feeds.has(id)) throw new ReaderConflict();
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      let stageReject: ((error: Error) => void) | null = null;
      const abort = () => finish();
      const timeout = setTimeout(
        () =>
          finish(
            new TransportError(
              503,
              'Reader timed out. Reconnect to recover this reply.',
            ),
          ),
        275_000,
      );
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        stageReject?.(error ?? new Error('Reader detached.'));
        signal.removeEventListener('abort', abort);
        this.feeds.delete(id);
        if (error) reject(error);
        else resolve();
      };
      const feed: Feed = { receive, finish, staged: null };
      this.feeds.set(id, feed);
      signal.addEventListener('abort', abort, { once: true });
      const send = async () => {
        for (const command of commands) {
          if (finished || signal.aborted) return;
          if (command.kind !== 'stage') {
            socket.send(JSON.stringify(command));
            continue;
          }
          await new Promise<void>((done, failed) => {
            const timeout = setTimeout(
              () => failed(new Error('Context upload timed out.')),
              15_000,
            );
            stageReject = error => {
              clearTimeout(timeout);
              failed(error);
            };
            feed.staged = index => {
              if (index !== command.index) return;
              clearTimeout(timeout);
              stageReject = null;
              feed.staged = null;
              done();
            };
            try {
              socket.send(JSON.stringify(command));
            } catch (error) {
              stageReject(
                error instanceof Error
                  ? error
                  : new Error('Context upload failed.'),
              );
            }
          });
        }
      };
      void send().catch(error =>
        finish(
          error instanceof Error ? error : new Error('Reply delivery failed.'),
        ),
      );
    });
  }

  disconnect(): void {
    for (const feed of this.feeds.values()) feed.finish();
    this.socket?.close(1000, 'Reader detached');
  }
}
