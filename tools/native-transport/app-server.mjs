// Local server for driving the full app on a simulator: the real routes,
// socket connection, and worker over PGlite, with a scripted fake provider.
// Run: node --experimental-transform-types --no-warnings
//        --import ./tools/native-transport/hooks.mjs tools/native-transport/app-server.mjs
//        --out <dir> [--port 8794] [--reply <file with {"reply": "..."}>]
//        [--host <private LAN IPv4>]
// --host adds one private address, so a phone on the same Wi-Fi can reach a
// Debug build's server. The server still listens on loopback.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { handleRequest, socketRoute } from '../../packages/server/src/api.ts';
import { SessionStore } from '../../packages/server/src/auth.ts';
import { JobRepository } from '../../packages/server/src/jobs.ts';
import { runAttempt } from '../../packages/server/src/worker.ts';
import { testDatabase } from '../../packages/server/tests/database.ts';
import { sessionTokenSchema } from '../../shared/contracts.ts';

const { WebSocketServer } = createRequire(
  new URL('../../packages/server/package.json', import.meta.url),
)('ws');
const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    port: { type: 'string', default: '8794' },
    reply: { type: 'string' },
    host: { type: 'string' },
  },
});
if (!args.out) throw new Error('Pass --out.');
const privateIPv4 =
  /^(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/u;
if (args.host !== undefined && !privateIPv4.test(args.host))
  throw new Error(
    '--host must be a private IPv4 address, such as 192.168.1.20.',
  );
mkdirSync(args.out, { recursive: true });
const started = Date.now();
const record = entry =>
  appendFileSync(
    join(args.out, 'access.log'),
    `${JSON.stringify({ t: Date.now() - started, ...entry })}\n`,
  );

const reply = args.reply
  ? JSON.parse(readFileSync(args.reply, 'utf8')).reply
  : 'Fixture reply from the local app server.';
const control = { paceMs: 40, holdAfter: null, waiting: new Set() };
const generations = [];

const providers = {
  async select(_input, _signal, beforeCall) {
    await beforeCall();
    return 'deepseek';
  },
  async prepare() {
    return { items: [], checkpoint: null };
  },
  async generate(input, model, _context, signal, onChunk, beforeCall) {
    await beforeCall();
    generations.push({ attemptId: input.attemptId, model });
    record({ event: 'generate', attemptId: input.attemptId, model });
    const pieces = reply.match(/\S+\s*/gu) ?? [];
    for (const [index, text] of pieces.entries()) {
      if (control.holdAfter !== null && index >= control.holdAfter)
        await new Promise((resolve, reject) => {
          control.waiting.add(resolve);
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      await delay(control.paceMs, undefined, { signal });
      await onChunk({
        wire: 'gateway',
        text,
        raw: JSON.stringify({
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: text } }],
        }),
      });
    }
    return { checkpoint: null };
  },
};

const { database } = await testDatabase();
const jobs = new JobRepository(database);
const dispatches = new Map();
const owners = new Map();
const harnessUser = 'app-harness-user';
const sessions = new SessionStore(database);
const services = {
  allowedAppleUserIds: harnessUser,
  appleKeys: () =>
    Promise.reject(new Error('The harness never signs in with Apple.')),
  sessions: () => Promise.resolve(sessions),
  jobs: () => Promise.resolve(jobs),
  rank: () => Promise.resolve([]),
  async dispatch(owner, attemptId) {
    dispatches.set(attemptId, (dispatches.get(attemptId) ?? 0) + 1);
    owners.set(attemptId, owner);
    record({ event: 'dispatch', attemptId });
    const runId = `run-${randomUUID()}`;
    void runAttempt({
      jobs,
      providers,
      owner,
      attemptId,
      runId,
      claimId: randomUUID(),
      heartbeatMs: 200,
      timeoutMs: 600_000,
      publish: () => Promise.resolve(),
    }).catch(error =>
      record({ event: 'worker-error', attemptId, message: error.message }),
    );
    return runId;
  },
};

const adopted = new Map();
function adopt(headers) {
  const token = sessionTokenSchema.safeParse(
    headers.authorization?.replace(/^Bearer /u, ''),
  );
  if (!token.success) return Promise.resolve();
  if (!adopted.has(token.data))
    adopted.set(
      token.data,
      sessions
        .create(token.data, harnessUser)
        .then(() => record({ event: 'adopted-session' })),
    );
  return adopted.get(token.data);
}

function webHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeHeaders))
    if (typeof value === 'string') headers.set(name, value);
  return headers;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function harness(url, req, res) {
  if (url.pathname === '/harness/control') {
    const command = JSON.parse((await readBody(req)).toString());
    if (command.op === 'pace') control.paceMs = command.ms;
    if (command.op === 'hold') control.holdAfter = command.after;
    if (command.op === 'release') {
      control.holdAfter = null;
      for (const resolve of control.waiting) resolve();
      control.waiting.clear();
    }
    record({ event: 'control', command });
    res.writeHead(204).end();
    return true;
  }
  if (url.pathname === '/harness/report') {
    appendFileSync(
      join(args.out, 'reports.jsonl'),
      `${(await readBody(req)).toString()}\n`,
    );
    res.writeHead(204).end();
    return true;
  }
  if (url.pathname === '/harness/jobs') {
    const result = [];
    for (const [attemptId, count] of dispatches) {
      const job = await jobs.get(owners.get(attemptId), attemptId);
      result.push({
        attemptId,
        dispatches: count,
        generations: generations.filter(item => item.attemptId === attemptId)
          .length,
        status: job.snapshot.status,
        text: job.snapshot.text,
        cancelRequested: job.snapshot.cancelRequested,
        delivered: job.snapshot.delivered,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }
  return false;
}

async function api(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (await harness(url, req, res)) return;
  await adopt(req.headers);
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const headers = webHeaders(req.headers);
  const body =
    req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : await readBody(req);
  const response = await handleRequest(
    new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
    }),
    services,
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done || res.destroyed) break;
      res.write(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  res.end();
}

const sockets = new WebSocketServer({ noServer: true });
const route = socketRoute(() => services);
async function upgrade(req, socket, head) {
  await adopt(req.headers);
  let admitted;
  try {
    admitted = await route.upgrade(
      new Request(`http://localhost${req.url}`, {
        headers: webHeaders(req.headers),
      }),
    );
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    record({ event: 'upgrade-refused', status: error.status });
    socket.end(
      `HTTP/1.1 ${error.status} Unauthorized\r\nConnection: close\r\n\r\n`,
    );
    return;
  }
  sockets.handleUpgrade(req, socket, head, client => {
    const peer = {
      context: admitted.context,
      websocket: client,
      send: data => client.send(data),
      close: (code, reason) => client.close(code, reason),
    };
    client.on('message', data => {
      record({ event: 'socket-frame' });
      void route.message(peer, { text: () => data.toString() });
    });
    client.on('close', () => {
      record({ event: 'socket-closed' });
      route.close(peer);
    });
  });
}

let nextRequest = 0;
for (const host of ['127.0.0.1', '::1', ...(args.host ? [args.host] : [])]) {
  const server = http.createServer((req, res) => {
    nextRequest += 1;
    const base = { id: nextRequest, method: req.method, path: req.url };
    // The probe's own reports would bury the app's traffic.
    const logged = !req.url.startsWith('/harness/');
    if (logged) record({ ...base, event: 'request' });
    res.on('close', () => {
      if (logged)
        record({
          ...base,
          event: res.writableFinished ? 'finished' : 'client-closed',
          status: res.headersSent ? res.statusCode : null,
        });
    });
    api(req, res).catch(error => {
      record({ ...base, event: 'handler-error', message: error.message });
      res.destroy();
    });
  });
  server.keepAliveTimeout = 0;
  server.on('upgrade', (req, socket, head) => {
    nextRequest += 1;
    record({
      id: nextRequest,
      method: 'UPGRADE',
      path: req.url,
      event: 'upgrade',
    });
    upgrade(req, socket, head).catch(error => {
      record({ event: 'upgrade-error', message: error.message });
      socket.destroy();
    });
  });
  server.listen(Number(args.port), host);
}
record({ event: 'listening', port: Number(args.port) });
