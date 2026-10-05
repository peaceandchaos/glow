import type { PGlite } from '@electric-sql/pglite';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  submissionCommands,
  submissionSchema,
  type ModelKey,
  type Submission,
} from '../../../shared/contracts';
import { handleRequest, type ApiServices } from '../src/api';
import { deviceOwner } from '../src/auth';
import { GatewayClient } from '../src/gateway';
import { JevClient } from '../src/jev';
import { JobRepository } from '../src/jobs';
import { LiveProviders } from '../src/providers';
import { ResponsesClient } from '../src/responses';
import { runAttempt } from '../src/worker';
import { testDatabase } from './database';

jest.setTimeout(30_000);

const device = randomBytes(32).toString('base64url');
const headers = { 'Content-Type': 'application/json', 'X-Device-Id': device };
const owner = deviceOwner(new Headers(headers), device);
// The size the app picker commonly produces at 2,048 px and quality 0.9.
const photo = `data:image/jpeg;base64,${randomBytes(750_000).toString('base64')}`;

let postgres: PGlite;
let jobs: JobRepository;
let socketServer: WebSocketServer;
let services: ApiServices;
const workers: Promise<void>[] = [];
// Every request body that reached a provider fixture.
const upstream: string[] = [];

function gatewayRecord(delta: string | null, finish: string | null): string {
  return `data: ${JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: delta }, finish_reason: finish }],
  })}\n\n`;
}

beforeAll(async () => {
  const fixture = await testDatabase();
  postgres = fixture.postgres;
  jobs = new JobRepository(fixture.database);
  socketServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    socketServer.once('listening', resolve);
    socketServer.once('error', reject);
  });
  const address = socketServer.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture address missing');
  socketServer.on('connection', socket => {
    socket.on('message', data => {
      upstream.push(Buffer.isBuffer(data) ? data.toString('utf8') : '');
      socket.send(
        JSON.stringify({ type: 'response.output_text.delta', delta: 'A cat.' }),
      );
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'response-example',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  { type: 'output_text', text: 'A cat.', annotations: [] },
                ],
              },
            ],
          },
        }),
      );
    });
  });
  const providers = new LiveProviders(
    new ResponsesClient({
      apiKey: 'example-key',
      socketUrl: `ws://127.0.0.1:${address.port}`,
    }),
    new GatewayClient({
      apiKey: 'example-key',
      fetcher: (_url, init) => {
        upstream.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(
          new Response(
            gatewayRecord('A cat.', null) +
              gatewayRecord(null, 'stop') +
              'data: [DONE]\n\n',
          ),
        );
      },
    }),
    new JevClient('example-key', () =>
      Promise.reject(new Error('Manual sends must not call Jev')),
    ),
  );
  services = {
    allowlist: device,
    jobs: () => Promise.resolve(jobs),
    rank: () => Promise.resolve([]),
    dispatch(dispatchOwner, attemptId) {
      workers.push(
        runAttempt({
          jobs,
          providers,
          owner: dispatchOwner,
          attemptId,
          runId: `run-${attemptId}`,
          claimId: randomUUID(),
          heartbeatMs: 10,
          timeoutMs: 20_000,
          publish: () => Promise.resolve(),
        }),
      );
      return Promise.resolve(`run-${attemptId}`);
    },
  };
});

afterAll(async () => {
  await Promise.allSettled(workers);
  await new Promise<void>(resolve => socketServer.close(() => resolve()));
  await postgres.close();
});

beforeEach(() => {
  upstream.length = 0;
});

function photoTurn(model: ModelKey, images: string[]): Submission {
  const userTurnId = randomUUID();
  return {
    version: 1,
    attemptId: randomUUID(),
    chatId: randomUUID(),
    pathId: randomUUID(),
    userTurnId,
    picker: model,
    retryModel: null,
    history: [
      {
        id: userTurnId,
        parentId: null,
        role: 'user',
        text: 'What is in this photo?',
        images,
        complete: true,
      },
    ],
    checkpoints: [],
  };
}

// Sends the turn as the phone does, in context parts over POST /v1/chat, and
// waits for the server's worker to finish it.
async function submitTurn(input: Submission) {
  for (const command of submissionCommands(input)) {
    const response = await handleRequest(
      new Request('https://fixture.example/v1/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(command),
      }),
      services,
    );
    expect(response.status).toBe(200);
    await response.body?.cancel();
  }
  await Promise.all(workers);
  const { status, error } = (await jobs.get(owner, input.attemptId)).snapshot;
  return { status, error };
}

test.each<ModelKey>(['kimi', 'deepseek', 'gpt-6.1-sol', 'gpt-6-astra'])(
  'a 1 MB photo from the picker reaches %s and the reply completes',
  async model => {
    expect(photo.length).toBeGreaterThan(1_000_000);
    const input = photoTurn(model, [photo]);
    expect(await submitTurn(input)).toEqual({
      status: 'completed',
      error: null,
    });
    expect(upstream).toHaveLength(1);
    expect(upstream[0]).toContain(photo);
  },
);

test.each<ModelKey>(['kimi', 'deepseek', 'gpt-6.1-sol', 'gpt-6-astra'])(
  'a message with the most and largest photos the contract accepts reaches %s',
  async model => {
    const photos = Array.from(
      { length: 4 },
      () =>
        `data:image/png;base64,${randomBytes(2_249_982).toString('base64')}`,
    );
    const input = photoTurn(model, photos);
    expect(submissionSchema.parse(input)).toEqual(input);
    expect(Math.min(...photos.map(item => item.length))).toBeGreaterThan(
      2_999_990,
    );
    expect(await submitTurn(input)).toEqual({
      status: 'completed',
      error: null,
    });
    expect(upstream).toHaveLength(1);
    for (const item of photos) expect(upstream[0]).toContain(item);
  },
);
