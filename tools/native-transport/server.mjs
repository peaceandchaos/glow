// Controlled localhost server for the native transport harness.
// Run: node --experimental-transform-types --no-warnings
//        --import ./tools/native-transport/hooks.mjs tools/native-transport/server.mjs
// It never logs the device credential, only whether a request carried it.
import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  executeCommand,
  handleRequest,
} from '../../packages/server/src/api.ts';
import { deviceOwner } from '../../packages/server/src/auth.ts';
import { JobRepository } from '../../packages/server/src/jobs.ts';
import { testDatabase } from '../../packages/server/tests/database.ts';

// The server package's declared ws, not the older copy Metro hoists to the root.
const { WebSocketServer } = createRequire(
  new URL('../../packages/server/package.json', import.meta.url),
)('ws');
const faults = JSON.parse(
  readFileSync(new URL('./faults.json', import.meta.url), 'utf8'),
);
const device = process.env.NATIVE_HARNESS_DEVICE;
const out = process.env.NATIVE_HARNESS_OUT;
if (!device || !out)
  throw new Error('Set NATIVE_HARNESS_DEVICE and NATIVE_HARNESS_OUT.');

const started = Date.now();
const record = (file, entry) =>
  appendFileSync(
    join(out, file),
    `${JSON.stringify({ t: Date.now() - started, ...entry })}\n`,
  );

const { database } = await testDatabase();
const jobs = new JobRepository(database);
const owner = deviceOwner(new Headers({ 'X-Device-Id': device }), device);
const dispatches = new Map();
const services = {
  allowlist: device,
  jobs: () => Promise.resolve(jobs),
  dispatch: (_owner, attemptId) => {
    dispatches.set(attemptId, (dispatches.get(attemptId) ?? 0) + 1);
    return Promise.resolve('fixture-run');
  },
  rank: () => Promise.resolve([]),
};
let dropNextChat = null;
let go = false;

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function drained(res) {
  return new Promise(resolve => {
    res.once('drain', resolve);
    res.once('close', resolve);
  });
}

async function write(res, chunk) {
  if (!res.write(chunk)) await drained(res);
}

const sse = message => `data: ${JSON.stringify(message)}\n\n`;
const ids = {
  chatId: '00000000-0000-4000-8000-0000000000c1',
  pathId: '00000000-0000-4000-8000-0000000000c2',
  userTurnId: '00000000-0000-4000-8000-0000000000c3',
};
const snapshot = (attemptId, status, text = '') => ({
  version: 1,
  attemptId,
  ...ids,
  sequence: 0,
  status,
  actualModel: 'kimi',
  text,
  reasoning: '',
  error: null,
  checkpoint: null,
  cancelRequested: false,
  delivered: false,
});
const provider = (attemptId, sequence, raw) => ({
  kind: 'event',
  event: {
    version: 1,
    attemptId,
    sequence,
    kind: 'provider',
    wire: 'gateway',
    raw,
  },
});
const terminal = (attemptId, sequence, text) => ({
  kind: 'event',
  event: {
    version: 1,
    attemptId,
    sequence,
    kind: 'snapshot',
    snapshot: snapshot(attemptId, 'completed', text),
  },
});

async function harness(url, req, res) {
  if (url.pathname === '/harness/report') {
    record('reports.jsonl', JSON.parse((await readBody(req)).toString()));
    res.writeHead(204).end();
    return true;
  }
  if (url.pathname === '/harness/control') {
    const command = JSON.parse((await readBody(req)).toString());
    if (command.op === 'go') go = true;
    if (command.op === 'drop') dropNextChat = command.when;
    if (command.op === 'complete') {
      await jobs.claim(owner, command.attemptId, 'fixture-run', 'fixture');
      await jobs.update(owner, command.attemptId, 'fixture', {
        text: command.text,
        status: 'completed',
        actualModel: 'kimi',
      });
    }
    res.writeHead(204).end();
    return true;
  }
  if (url.pathname === '/harness/connections') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(openSockets).map(([name, set]) => [name, set.size]),
        ),
      ),
    );
    return true;
  }
  if (url.pathname === '/harness/uncredentialed') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('control');
    return true;
  }
  if (url.pathname === '/harness/go') {
    res.writeHead(go ? 204 : 425).end();
    return true;
  }
  if (url.pathname.startsWith('/harness/job/')) {
    const attemptId = url.pathname.slice('/harness/job/'.length);
    const job = await jobs.get(owner, attemptId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        snapshot: job.snapshot,
        dispatches: dispatches.get(attemptId) ?? 0,
      }),
    );
    return true;
  }
  return false;
}

async function api(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (await harness(url, req, res)) return;
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    if (typeof value === 'string') headers.set(name, value);
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
  const drop = url.pathname === '/v1/chat' ? dropNextChat : null;
  if (drop) dropNextChat = null;
  if (drop === 'before-accepted') {
    record('access.log', { event: 'drop-before-accepted', path: req.url });
    await response.body?.cancel();
    req.socket.destroy();
    return;
  }
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
      await write(res, chunk.value);
      if (drop === 'after-accepted') {
        await delay(100);
        record('access.log', { event: 'drop-after-accepted', path: req.url });
        req.socket.destroy();
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  res.end();
}

async function fault(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname.split('/');
  const id = path[3];
  const admission = Object.entries(faults.admission).find(
    ([, value]) => value === id,
  );
  if (admission) {
    res.writeHead(Number(admission[0]), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Fixture admission ${admission[0]}.` }));
    return;
  }
  if (id === faults.hold) return;
  if (id === faults.redirect) {
    res.writeHead(307, {
      Location: `http://localhost:${faults.ports.target}${req.url}`,
    });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
  });
  await write(
    res,
    sse({ kind: 'accepted', snapshot: snapshot(id, 'generating') }),
  );
  if (id === faults.drip) {
    for (let sequence = 1; !res.destroyed; sequence += 1) {
      await write(
        res,
        sse(provider(id, sequence, `RESPONSE-BODY-MARKER ${sequence}`)),
      );
      await delay(100);
    }
    return;
  }
  if (id === faults.utf8) {
    const bytes = Buffer.from(
      sse(provider(id, 1, faults.utf8Text)) +
        sse(terminal(id, 2, faults.utf8Text)),
    );
    for (let offset = 0; offset < bytes.length; offset += 3) {
      await write(res, bytes.subarray(offset, offset + 3));
      await delay(10);
    }
    res.end();
    return;
  }
  if (id === faults.truncated) {
    await write(
      res,
      sse(provider(id, 1, 'this record never ends')).slice(0, 40),
    );
    await delay(200);
    req.socket.destroy();
    return;
  }
  if (id === faults.earlyEnd) {
    res.end(sse(provider(id, 1, 'no terminal record follows')));
    return;
  }
  if (id === faults.malformed) {
    res.end('data: {"kind":"event","event":\n\n');
    return;
  }
  if (id === faults.large) {
    const raw = 'aé'.repeat(faults.largeRecordCharacters / 2);
    let waits = 0;
    for (let sequence = 1; sequence <= faults.largeRecords; sequence += 1) {
      if (res.destroyed) return;
      if (!res.write(sse(provider(id, sequence, raw)))) {
        waits += 1;
        await drained(res);
      }
    }
    record('access.log', { event: 'large-backpressure', waits });
    res.end(sse(terminal(id, faults.largeRecords + 1, 'large done')));
    return;
  }
  res.end();
}

async function target(req, res) {
  if (req.url.endsWith('/events')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const id = req.url.split('/')[3];
    res.end(
      sse({
        kind: 'accepted',
        snapshot: snapshot(id, 'completed', 'served by redirect target'),
      }),
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(snapshot(req.url.split('/')[3], 'completed')));
}

const sockets = new WebSocketServer({ noServer: true });

// Real acceptance for Auto/GPT submissions; the job then completes at once.
function acceptSocket(req, socket, head) {
  if (req.headers['x-device-id'] !== device) {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, client => {
    client.on('message', async data => {
      const command = JSON.parse(data.toString());
      const accepted = await executeCommand(owner, command, services);
      client.send(JSON.stringify(accepted));
      if (accepted.kind !== 'accepted') return;
      const { attemptId, sequence } = accepted.snapshot;
      await jobs.claim(owner, attemptId, 'fixture-run', 'fixture');
      await jobs.update(owner, attemptId, 'fixture', {
        text: 'RESPONSE-BODY-MARKER socket',
        status: 'completed',
        actualModel: 'gpt-6.1-sol',
      });
      for (const event of await jobs.events(owner, attemptId, sequence))
        client.send(JSON.stringify({ kind: 'event', event }));
    });
  });
}

const upgrades = {
  api: acceptSocket,
  fault: (req, socket) =>
    socket.end(
      `HTTP/1.1 307 Temporary Redirect\r\nLocation: ws://localhost:${faults.ports.target}${req.url}\r\nContent-Length: 0\r\n\r\n`,
    ),
  target: (_req, socket) => socket.destroy(),
};
const openSockets = { api: new Set(), fault: new Set(), target: new Set() };
let nextRequest = 0;
function serve(name, port, handler) {
  const listener = (req, res) => {
    nextRequest += 1;
    const base = {
      server: name,
      id: nextRequest,
      method: req.method,
      path: req.url,
    };
    const header = req.headers['x-device-id'];
    record('access.log', {
      ...base,
      event: 'request',
      credential:
        header === undefined
          ? 'absent'
          : header === device
            ? 'fixture'
            : 'other',
    });
    let bytes = 0;
    const original = res.write.bind(res);
    res.write = (chunk, ...rest) => {
      bytes += Buffer.byteLength(chunk);
      return original(chunk, ...rest);
    };
    res.on('close', () =>
      record('access.log', {
        ...base,
        event: res.writableFinished ? 'finished' : 'client-closed',
        status: res.headersSent ? res.statusCode : null,
        bytes,
      }),
    );
    handler(req, res).catch(error => {
      record('access.log', {
        ...base,
        event: 'handler-error',
        message: String(error?.message),
      });
      res.destroy();
    });
  };
  for (const host of ['127.0.0.1', '::1']) {
    const server = http.createServer(listener);
    // Only the client decides when an idle connection closes.
    server.keepAliveTimeout = 0;
    server.on('upgrade', (req, socket, head) => {
      nextRequest += 1;
      const header = req.headers['x-device-id'];
      record('access.log', {
        server: name,
        id: nextRequest,
        method: 'UPGRADE',
        path: req.url,
        event: 'upgrade',
        credential:
          header === undefined
            ? 'absent'
            : header === device
              ? 'fixture'
              : 'other',
      });
      upgrades[name](req, socket, head);
    });
    server.on('connection', socket => {
      openSockets[name].add(socket);
      socket.on('close', () => openSockets[name].delete(socket));
    });
    server.listen(port, host);
  }
}

serve('api', faults.ports.api, api);
serve('fault', faults.ports.fault, fault);
serve('target', faults.ports.target, target);
record('access.log', { event: 'listening', ports: faults.ports });
