import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import {
  decode,
  decodeJson,
  idSchema,
  searchRequestSchema,
  sessionRequestSchema,
  socketCommandSchema,
  type SearchRequest,
  type ServerMessage,
  type SessionResponse,
  type SocketCommand,
} from '../../../shared/contracts';
import {
  allows,
  appleSignIn,
  bearerToken,
  newSessionToken,
  sessionOwner,
  type SessionStore,
} from './auth';
import { deliverJob, jobStream } from './delivery';
import { RequestError } from './errors';
import { InputParts } from './input-parts';
import { staleAfterMs, type Dispatcher, type JobRepository } from './jobs';

export type ApiServices = {
  allowedAppleUserIds: string;
  appleKeys: JWTVerifyGetKey;
  sessions: () => Promise<SessionStore>;
  jobs: () => Promise<JobRepository>;
  dispatch: Dispatcher;
  rank: (input: SearchRequest, signal: AbortSignal) => Promise<string[]>;
};

// Reads the attempt a frame names, even when the frame fails strict
// validation, so its refusal reaches that attempt's reader only.
const namedAttemptSchema = z.object({
  attemptId: idSchema.optional(),
  submission: z.object({ attemptId: idSchema }).optional(),
});

const acknowledgeSchema = z.strictObject({
  sequence: z.number().int().nonnegative().safe(),
});
const maxRequestBytes = 4_000_000;

async function readBody(request: Request): Promise<string> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json'))
    throw new RequestError(415, 'Send JSON.');
  if (!request.body) throw new RequestError(400, 'Missing request body.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxRequestBytes)
        throw new RequestError(
          413,
          'Split large conversation input into context parts.',
        );
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new RequestError(400, 'Send JSON as UTF-8 text.');
  }
}

function errorResponse(error: Error | Response): Response {
  if (error instanceof Response) return error;
  if (error instanceof RequestError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return Response.json(
      { error: 'Invalid request data or contract version.' },
      { status: 400 },
    );
  return Response.json(
    { error: 'The server could not complete this request.' },
    { status: 503 },
  );
}

export async function executeCommand(
  owner: string,
  command: SocketCommand,
  services: ApiServices,
): Promise<ServerMessage> {
  const jobs = await services.jobs();
  switch (command.kind) {
    case 'stage':
      await new InputParts(jobs).stage(owner, command);
      return {
        kind: 'staged',
        attemptId: command.attemptId,
        index: command.index,
      };
    case 'commit': {
      const job = await new InputParts(jobs).commit(
        owner,
        command,
        services.dispatch,
      );
      return { kind: 'accepted', snapshot: job.snapshot };
    }
    case 'submit': {
      const job = await jobs.submit(
        owner,
        command.submission,
        services.dispatch,
      );
      return { kind: 'accepted', snapshot: job.snapshot };
    }
    case 'attach': {
      const job = await jobs.reconcile(owner, command.attemptId, staleAfterMs);
      return { kind: 'accepted', snapshot: job.snapshot };
    }
  }
}

export type SocketPeer = {
  readonly context: object;
  readonly websocket: { readonly readyState?: number };
  send(text: string): void;
  close(code?: number, reason?: string): void;
};

class SocketConnection {
  private readonly readers = new Map<string, AbortController>();

  private constructor(
    private readonly owner: string,
    private readonly services: () => ApiServices,
  ) {}

  static async admit(
    headers: Headers,
    services: () => ApiServices,
  ): Promise<SocketConnection> {
    return new SocketConnection(
      await sessionOwner(headers, services()),
      services,
    );
  }

  async message(peer: SocketPeer, read: () => string): Promise<void> {
    const services = this.services();
    if (!allows(services.allowedAppleUserIds, this.owner)) {
      peer.close(1008, 'Unauthorized');
      return;
    }
    const send = (message: ServerMessage) => {
      peer.send(JSON.stringify(message));
      return Promise.resolve();
    };
    let attemptId: string | null = null;
    try {
      const raw = read();
      if (Buffer.byteLength(raw, 'utf8') > 4_000_000)
        throw new RequestError(413, 'Split large input into context parts.');
      const frame = JSON.parse(raw);
      const named = namedAttemptSchema.safeParse(frame);
      if (named.success)
        attemptId =
          named.data.submission?.attemptId ?? named.data.attemptId ?? null;
      const command = decode(socketCommandSchema, frame);
      attemptId =
        command.kind === 'submit'
          ? command.submission.attemptId
          : command.attemptId;
      const result = await executeCommand(this.owner, command, services);
      if (peer.websocket.readyState !== 1) return;
      if (result.kind !== 'accepted') {
        await send(result);
        return;
      }
      this.readers.get(attemptId)?.abort();
      const controller = new AbortController();
      this.readers.set(attemptId, controller);
      const replyId = attemptId;
      void deliverJob(
        await services.jobs(),
        this.owner,
        replyId,
        controller.signal,
        send,
      )
        .then(() => {
          if (!controller.signal.aborted)
            return send({ kind: 'detached', attemptId: replyId });
        })
        .catch(() =>
          send({
            kind: 'error',
            attemptId: replyId,
            message:
              'Delivery was interrupted. Reconnect to recover this reply.',
          }),
        )
        .finally(() => {
          if (this.readers.get(replyId) === controller)
            this.readers.delete(replyId);
        });
    } catch (error) {
      await send({
        kind: 'error',
        attemptId,
        status:
          error instanceof RequestError
            ? error.status
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? 400
              : 503,
        message:
          error instanceof RequestError
            ? error.message
            : 'The server could not accept this request.',
      });
    }
  }

  detachReaders(): void {
    for (const reader of this.readers.values()) reader.abort();
    this.readers.clear();
  }
}

function connectionOf({ context }: SocketPeer): SocketConnection | null {
  return 'connection' in context &&
    context.connection instanceof SocketConnection
    ? context.connection
    : null;
}

export function socketRoute(services: () => ApiServices) {
  return {
    async upgrade(request: Request) {
      const connection = await SocketConnection.admit(
        request.headers,
        services,
      );
      return { context: { connection } };
    },
    async message(peer: SocketPeer, message: { text(): string }) {
      const connection = connectionOf(peer);
      if (connection) await connection.message(peer, () => message.text());
      else peer.close(1011, 'Server error');
    },
    close(peer: SocketPeer) {
      connectionOf(peer)?.detachReaders();
    },
  };
}

async function handleJobRoute(
  request: Request,
  owner: string,
  id: string,
  action: string | undefined,
  services: ApiServices,
): Promise<Response> {
  const attemptId = idSchema.parse(id);
  const jobs = await services.jobs();
  if (request.method === 'GET' && !action)
    return Response.json(
      (await jobs.reconcile(owner, attemptId, staleAfterMs)).snapshot,
      { headers: { 'Cache-Control': 'no-store' } },
    );
  if (request.method === 'GET' && action === 'events') {
    await jobs.get(owner, attemptId);
    return jobStream(jobs, owner, attemptId, request.signal);
  }
  if (request.method === 'POST' && action === 'stop') {
    const result = await jobs.requestCancellation(owner, attemptId);
    return result ? Response.json(result) : new Response(null, { status: 204 });
  }
  if (request.method === 'POST' && action === 'ack') {
    const body = decodeJson(acknowledgeSchema, await readBody(request));
    await jobs.acknowledge(owner, attemptId, body.sequence);
    return new Response(null, { status: 204 });
  }
  throw new RequestError(404, 'Route not found.');
}

async function signIn(
  request: Request,
  services: ApiServices,
): Promise<Response> {
  const body = decodeJson(sessionRequestSchema, await readBody(request));
  const apple = await appleSignIn(
    body.identityToken,
    body.rawNonce,
    services.appleKeys,
  );
  if (!allows(services.allowedAppleUserIds, apple.user)) {
    console.warn(
      `sign-in refused: ALLOWED_APPLE_USER_IDS does not list Apple user ${apple.user}`,
    );
    throw new RequestError(403, 'This Apple account is not allowed.');
  }
  const token = newSessionToken();
  await (await services.sessions()).create(token, apple);
  return Response.json({ token } satisfies SessionResponse, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function handleSignedInRoute(
  request: Request,
  owner: string,
  path: string[],
  services: ApiServices,
): Promise<Response> {
  if (path[0] !== 'v1') throw new RequestError(404, 'Route not found.');
  if (
    path[1] === 'session' &&
    path.length === 2 &&
    request.method === 'DELETE'
  ) {
    await (await services.sessions()).revoke(bearerToken(request.headers));
    return new Response(null, { status: 204 });
  }
  if (path[1] === 'chat' && path.length === 2 && request.method === 'POST') {
    const command = decodeJson(socketCommandSchema, await readBody(request));
    const result = await executeCommand(owner, command, services);
    if (result.kind !== 'accepted') return Response.json(result);
    return jobStream(
      await services.jobs(),
      owner,
      result.snapshot.attemptId,
      request.signal,
    );
  }
  if (path[1] === 'jobs' && path[2] && path.length <= 4)
    return handleJobRoute(request, owner, path[2], path[3], services);
  if (
    path[1] === 'chats' &&
    path[2] &&
    path.length === 3 &&
    request.method === 'DELETE'
  ) {
    await (await services.jobs()).deleteChat(owner, idSchema.parse(path[2]));
    return new Response(null, { status: 204 });
  }
  if (path[1] === 'search' && path.length === 2 && request.method === 'POST') {
    const body = decodeJson(searchRequestSchema, await readBody(request));
    return Response.json({ ids: await services.rank(body, request.signal) });
  }
  throw new RequestError(404, 'Route not found.');
}

export async function handleRequest(
  request: Request,
  services: ApiServices,
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname.split('/').filter(Boolean);
    if (path.join('/') === 'v1/session' && request.method === 'POST')
      return await signIn(request, services);
    const owner = await sessionOwner(request.headers, services);
    return await handleSignedInRoute(request, owner, path, services);
  } catch (error) {
    return errorResponse(
      error instanceof Error || error instanceof Response
        ? error
        : new Error('Request failed.'),
    );
  }
}
