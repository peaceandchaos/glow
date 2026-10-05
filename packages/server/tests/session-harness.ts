import type { PGlite } from '@electric-sql/pglite';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ContextCheckpoint,
  ModelKey,
  Picker,
  ServerMessage,
  Submission,
} from '../../../shared/contracts';
import { ChatArchive, type ArchiveStorage } from '../../app/src/state/archive';
import {
  ServerTransport,
  type ClientDrivers,
  type ClientReader,
  type ClientResponse,
  type ClientSocket,
} from '../../app/src/network/client';
import { ChatSession } from '../../app/src/state/session';
import { handleRequest, SocketConnection, type ApiServices } from '../src/api';
import { deviceOwner } from '../src/auth';
import { ProviderFailure } from '../src/errors';
import { JobRepository } from '../src/jobs';
import type {
  PreparedContext,
  ProviderChunk,
  Providers,
} from '../src/provider';
import { runAttempt } from '../src/worker';
import { testDatabase } from './database';

export class MemoryStorage implements ArchiveStorage {
  readonly values: Map<string, string>;
  readonly writes: string[] = [];
  failing = false;
  constructor(values = new Map<string, string>()) {
    this.values = new Map(values);
  }
  getString(key: string) {
    return this.values.get(key);
  }
  getAllKeys() {
    return [...this.values.keys()];
  }
  set(key: string, value: string) {
    if (this.failing) throw new Error('Simulated storage failure');
    this.writes.push(key);
    this.values.set(key, value);
  }
  remove(key: string) {
    if (this.failing) throw new Error('Simulated storage failure');
    this.values.delete(key);
  }
  // What a terminated process leaves on disk.
  snapshot(): MemoryStorage {
    return new MemoryStorage(this.values);
  }
}

type Step =
  | { kind: 'item'; type: 'reasoning' | 'message' }
  | { kind: 'text'; text: string }
  | { kind: 'end'; checkpoint: ContextCheckpoint | null }
  | { kind: 'fail' };

// The provider side of one attempt. The test decides when each chunk arrives.
class Script {
  private readonly steps: Step[] = [];
  private wake: (() => void) | null = null;
  // A Responses output item starting, before any of its text.
  item(type: 'reasoning' | 'message'): this {
    this.push({ kind: 'item', type });
    return this;
  }
  text(...pieces: string[]): this {
    for (const text of pieces) this.push({ kind: 'text', text });
    return this;
  }
  end(checkpoint: ContextCheckpoint | null = null): this {
    this.push({ kind: 'end', checkpoint });
    return this;
  }
  fail(): this {
    this.push({ kind: 'fail' });
    return this;
  }
  private push(step: Step) {
    this.steps.push(step);
    this.wake?.();
  }
  async next(signal: AbortSignal): Promise<Step> {
    for (;;) {
      signal.throwIfAborted();
      const step = this.steps.shift();
      if (step) return step;
      await new Promise<void>(resolve => {
        this.wake = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      this.wake = null;
    }
  }
}

function providerChunk(model: ModelKey, text: string): ProviderChunk {
  return model === 'kimi' || model === 'deepseek'
    ? {
        wire: 'gateway',
        text,
        raw: JSON.stringify({
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: text } }],
        }),
      }
    : {
        wire: 'responses',
        text,
        raw: JSON.stringify({
          type: 'response.output_text.delta',
          delta: text,
        }),
      };
}

class FakeProviders implements Providers {
  selection: ModelKey | 'fail' = 'deepseek';
  selections = 0;
  readonly generations: { input: Submission; model: ModelKey }[] = [];
  private readonly scripts = new Map<string, Script>();

  script(attemptId: string): Script {
    const existing = this.scripts.get(attemptId);
    if (existing) return existing;
    const script = new Script();
    this.scripts.set(attemptId, script);
    return script;
  }

  async select(
    _input: Submission,
    _signal: AbortSignal,
    beforeCall: () => Promise<void>,
  ): Promise<ModelKey> {
    await beforeCall();
    this.selections += 1;
    if (this.selection === 'fail')
      throw new ProviderFailure('The model chooser could not answer.');
    return this.selection;
  }

  async prepare() {
    return { items: [], checkpoint: null };
  }

  async generate(
    input: Submission,
    model: ModelKey,
    _context: PreparedContext,
    signal: AbortSignal,
    onChunk: (chunk: ProviderChunk) => Promise<void>,
    beforeCall: () => Promise<void>,
  ) {
    await beforeCall();
    this.generations.push({ input, model });
    const script = this.script(input.attemptId);
    for (;;) {
      const step = await script.next(signal);
      if (step.kind === 'end') return { checkpoint: step.checkpoint };
      if (step.kind === 'fail')
        throw new ProviderFailure('The provider stopped responding.', true);
      await onChunk(
        step.kind === 'item'
          ? {
              wire: 'responses',
              raw: JSON.stringify({
                type: 'response.output_item.added',
                item: { type: step.type },
              }),
            }
          : providerChunk(model, step.text),
      );
    }
  }
}

// Controls what the phone's network does, independently of the server.
export class Network {
  online = true;
  private dropNext: ((url: string, method: string) => boolean) | null = null;
  private readonly readers = new Set<CuttableReader>();
  readonly requests: string[] = [];
  beforeRequest: ((method: string, path: string) => void) | null = null;
  // Answers a request before it reaches the server, as a proxy or an older
  // server version would.
  respond: ((method: string, path: string) => number | null) | null = null;
  // Rewrites what the phone sends, as an older or newer client would.
  rewrite: ((body: string) => string) | null = null;

  // The server handles the next matching request, but its response is lost.
  loseResponse(match: (url: string, method: string) => boolean): void {
    this.dropNext = match;
  }
  shouldLose(url: string, method: string): boolean {
    if (!this.dropNext?.(url, method)) return false;
    this.dropNext = null;
    return true;
  }
  track(reader: CuttableReader): void {
    this.readers.add(reader);
  }
  release(reader: CuttableReader): void {
    this.readers.delete(reader);
  }
  cutStreams(): void {
    for (const reader of this.readers) reader.cut();
  }
  // The server ends each open reply stream cleanly, as it does when its
  // delivery window closes before the reply finishes.
  endStreams(): void {
    for (const reader of this.readers) reader.end();
  }
  get openStreams(): number {
    return this.readers.size;
  }
}

class CuttableReader implements ClientReader {
  private cutError: ((error: Error) => void) | null = null;
  private readonly cutSignal = new Promise<never>((_resolve, reject) => {
    this.cutError = reject;
  });
  private endStream: (() => void) | null = null;
  private readonly endSignal = new Promise<{ done: true }>(resolve => {
    this.endStream = () => resolve({ done: true });
  });
  constructor(
    private readonly inner: ReadableStreamDefaultReader<Uint8Array>,
    private readonly network: Network,
    private readonly duplicate: boolean,
  ) {
    this.cutSignal.catch(() => undefined);
    network.track(this);
  }
  cut() {
    this.cutError?.(new TypeError('Network connection lost'));
  }
  end() {
    this.endStream?.();
  }
  async read(): Promise<{ done: boolean; value?: Uint8Array }> {
    const chunk = await Promise.race([
      this.inner.read(),
      this.cutSignal,
      this.endSignal,
    ]);
    if (chunk.done || !this.duplicate) return chunk;
    // At-least-once delivery: every record arrives twice.
    const value = new Uint8Array(chunk.value.length * 2);
    value.set(chunk.value);
    value.set(chunk.value, chunk.value.length);
    return { done: false, value };
  }
  cancel() {
    this.network.release(this);
    return this.inner.cancel();
  }
  releaseLock() {
    this.network.release(this);
    this.inner.releaseLock();
  }
}

export type Server = {
  postgres: PGlite;
  jobs: JobRepository;
  services: ApiServices;
  owner: string;
  device: string;
  providers: FakeProviders;
  dispatched: string[];
  duplicateDelivery: boolean;
  phones: Phone[];
  sockets: InProcessSocket[];
  // While set, durable dispatch waits, so a submission stays unaccepted.
  dispatchGate: Promise<void> | null;
  settle: () => Promise<void>;
};

export async function startServer(): Promise<Server> {
  const { database, postgres } = await testDatabase();
  const jobs = new JobRepository(database);
  const device = randomBytes(32).toString('base64url');
  const owner = deviceOwner(new Headers({ 'X-Device-Id': device }), device);
  const providers = new FakeProviders();
  const dispatched: string[] = [];
  const workers = new Set<Promise<void>>();
  let gate: Promise<void> | null = null;
  const services: ApiServices = {
    allowlist: device,
    jobs: () => Promise.resolve(jobs),
    rank: () => Promise.resolve([]),
    // Durable dispatch starts the real worker asynchronously, as Workflow does.
    async dispatch(dispatchOwner, attemptId) {
      dispatched.push(attemptId);
      await gate;
      const runId = `run-${dispatched.length}`;
      const worker = runAttempt({
        jobs,
        providers,
        owner: dispatchOwner,
        attemptId,
        runId,
        claimId: randomUUID(),
        heartbeatMs: 10,
        timeoutMs: 20_000,
        publish: () => Promise.resolve(),
      });
      workers.add(worker);
      void worker.finally(() => workers.delete(worker));
      return runId;
    },
  };
  return {
    postgres,
    jobs,
    services,
    owner,
    device,
    providers,
    dispatched,
    duplicateDelivery: false,
    phones: [],
    sockets: [],
    get dispatchGate() {
      return gate;
    },
    set dispatchGate(value) {
      gate = value;
    },
    async settle() {
      await Promise.allSettled([...workers]);
    },
  };
}

function fetchDriver(server: Server, network: Network): ClientDrivers['fetch'] {
  return async (url, init) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname;
    network.requests.push(`${method} ${path}`);
    network.beforeRequest?.(method, path);
    if (!network.online) throw new TypeError('Network request failed');
    const answered = network.respond?.(method, path);
    if (answered) {
      const refusal: ClientResponse = {
        ok: false,
        status: answered,
        text: () => Promise.resolve('{"error":"Answered before the server."}'),
        body: null,
      };
      return refusal;
    }
    const { stream: _stream, ...requestInit } = init;
    if (typeof requestInit.body === 'string' && network.rewrite)
      requestInit.body = network.rewrite(requestInit.body);
    const response = await handleRequest(
      new Request(url, requestInit),
      server.services,
    );
    if (network.shouldLose(url, method)) {
      await response.body?.cancel();
      throw new TypeError('Network connection lost');
    }
    const body = response.body;
    const result: ClientResponse = {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
      body: body
        ? {
            getReader: () =>
              new CuttableReader(
                body.getReader(),
                network,
                server.duplicateDelivery,
              ),
          }
        : null,
    };
    return result;
  };
}

// A WebSocket frame shell around the route's own SocketConnection. Frames
// cross asynchronously, as they would over a network.
class InProcessSocket implements ClientSocket {
  readyState = 'CONNECTING';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((error: string) => void) | null = null;
  private readonly connection: SocketConnection;

  constructor(
    server: Server,
    private readonly network: Network,
    headers: Record<string, string>,
  ) {
    this.connection = new SocketConnection(
      new Headers(headers),
      () => server.services,
      {
        isOpen: () => this.readyState === 'OPEN',
        send: data => {
          if (this.readyState === 'OPEN')
            setTimeout(() => this.onmessage?.({ data }), 0);
        },
        close: code => this.close(code),
      },
    );
    server.sockets.push(this);
    setTimeout(() => {
      if (!network.online) {
        this.readyState = 'CLOSED';
        this.onerror?.('offline');
        return;
      }
      try {
        deviceOwner(new Headers(headers), server.services.allowlist);
      } catch {
        this.close(1008);
        return;
      }
      this.readyState = 'OPEN';
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    const frame = this.network.rewrite?.(data) ?? data;
    void this.connection.message(() => frame);
  }

  // A frame from some other command on this connection.
  inject(data: string): void {
    void this.connection.message(() => data);
  }

  // A frame from the server, such as the route's end-of-window detach.
  deliver(message: ServerMessage): void {
    const data = JSON.stringify(message);
    setTimeout(() => this.onmessage?.({ data }), 0);
  }

  close(code = 1000): void {
    if (this.readyState === 'CLOSED') return;
    this.readyState = 'CLOSED';
    this.connection.close();
    this.onclose?.({ code });
  }
}

export type Phone = {
  storage: MemoryStorage;
  archive: ChatArchive;
  transport: ServerTransport;
  session: ChatSession;
  network: Network;
};

let idCounter = 0;
export function uuid(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, '0')}`;
}

export function openPhone(
  server: Server,
  storage = new MemoryStorage(),
  network = new Network(),
  checkpointMs = 40,
): Phone {
  const archive = new ChatArchive(storage, uuid);
  archive.recover();
  const transport = new ServerTransport(
    'http://127.0.0.1:8787',
    server.device,
    {
      fetch: fetchDriver(server, network),
      socket: (_url, headers) => new InProcessSocket(server, network, headers),
      decoder: () => new TextDecoder(),
    },
    true,
  );
  const session = new ChatSession({
    archive,
    transport,
    scheduleFrame: callback => setTimeout(callback, 0),
    checkpointMs,
    retryBaseMs: 10,
    retryMaxMs: 60,
  });
  const phone = { storage, archive, transport, session, network };
  server.phones.push(phone);
  session.setLifecycle('active');
  return phone;
}

export async function until(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs)
      throw new Error(`Timed out waiting until ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

export async function serverSnapshot(server: Server, attemptId: string) {
  return (await server.jobs.get(server.owner, attemptId)).snapshot;
}

export async function shutdown(server: Server) {
  for (const phone of server.phones) phone.session.setLifecycle('background');
  for (const id of server.dispatched)
    await server.jobs.requestCancellation(server.owner, id);
  await server.settle();
  await server.postgres.close();
}

// Reads what a restarted process would find on disk.
export function reopen(storage: MemoryStorage): ChatArchive {
  const archive = new ChatArchive(storage.snapshot(), uuid);
  archive.recover();
  return archive;
}

export function createChat(phone: Phone, picker: Picker) {
  const chat = phone.archive.createChat();
  phone.archive.setPicker(chat.id, picker);
  return phone.archive.chat(chat.id);
}

export function settled(phone: Phone, attemptId: string) {
  return until(`reply ${attemptId} is settled`, () => {
    try {
      return !phone.archive.metadata().jobIds.includes(attemptId);
    } catch {
      return false;
    }
  });
}
