import type { PGlite } from '@electric-sql/pglite';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { bakedCatalog } from '../../../shared/catalog';
import { makeCheckpoint, textItem } from '../src/compaction/context';
import { GatewayClient } from '../src/gateway';
import { JevClient } from '../src/jev';
import { JobRepository } from '../src/jobs';
import type { RegistryKey } from '../src/models';
import { LiveProviders } from '../src/providers';
import { ResponsesClient } from '../src/responses';
import { runAttempt } from '../src/worker';
import { testDatabase } from './database';
import { exampleGatewayAuth, submission } from './fixtures';

jest.setTimeout(30_000);
const owner = 'd'.repeat(64);
const before = () => Promise.resolve();
const signal = new AbortController().signal;
const userText = 'Private question';
const replyText = 'Private answer';
let postgres: PGlite;
let jobs: JobRepository;
let socket: WebSocketServer;
let gatewayBodies: string[];
let socketRequests: string[];
let gatewayModel: string | undefined;
let info: jest.SpyInstance;

function gatewayStream(): Response {
  const record = (content: string | null, finish: string | null) =>
    JSON.stringify({
      object: 'chat.completion.chunk',
      ...(gatewayModel ? { model: gatewayModel } : {}),
      choices: [{ index: 0, delta: { content }, finish_reason: finish }],
    });
  const records = [record(replyText, null), record(null, 'stop'), '[DONE]'];
  return new Response(records.map(raw => `data: ${raw}\n\n`).join(''));
}

function providers(routed: RegistryKey): LiveProviders {
  const address = socket.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture address missing');
  return new LiveProviders(
    new ResponsesClient({
      apiKey: 'example-key',
      socketUrl: `ws://127.0.0.1:${address.port}`,
    }),
    new GatewayClient({
      auth: exampleGatewayAuth,
      fetcher: (_url, init) => {
        gatewayBodies.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(gatewayStream());
      },
    }),
    new JevClient(exampleGatewayAuth, () =>
      Promise.resolve(
        Response.json({
          answers: { model: { type: 'choice', choice: routed } },
        }),
      ),
    ),
  );
}

function sentRequest(model: RegistryKey): string {
  const sent = model === 'kimi' ? gatewayBodies : socketRequests;
  expect(sent).toHaveLength(1);
  return sent[0];
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

beforeAll(async () => {
  const fixture = await testDatabase();
  postgres = fixture.postgres;
  jobs = new JobRepository(fixture.database);
  socket = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    socket.once('listening', resolve);
    socket.once('error', reject);
  });
  socket.on('connection', connection => {
    connection.on('message', data => {
      socketRequests.push(Buffer.isBuffer(data) ? data.toString('utf8') : '');
      const response = {
        id: 'response-example',
        model: 'gpt-6.1-sol-2026-09-15',
      };
      connection.send(JSON.stringify({ type: 'response.created', response }));
      connection.send(
        JSON.stringify({
          type: 'response.output_text.delta',
          delta: replyText,
        }),
      );
      connection.send(
        JSON.stringify({
          type: 'response.completed',
          response: {
            ...response,
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: replyText }],
              },
            ],
          },
        }),
      );
    });
  });
});
beforeEach(async () => {
  await postgres.exec('TRUNCATE chat_job_events, chat_jobs');
  gatewayBodies = [];
  socketRequests = [];
  gatewayModel = 'moonshotai/kimi-k3-0905';
  info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => info.mockRestore());
afterAll(async () => {
  await new Promise<void>(resolve => socket.close(() => resolve()));
  await postgres.close();
});

async function autoReply(routed: RegistryKey): Promise<string> {
  const input = submission();
  input.history[0].text = userText;
  await jobs.submit(owner, input, async () => 'run');
  await runAttempt({
    jobs,
    providers: providers(routed),
    catalog: bakedCatalog,
    owner,
    attemptId: input.attemptId,
    runId: 'run',
    claimId: 'claim',
    heartbeatMs: 5,
    timeoutMs: 5_000,
  });
  expect((await jobs.get(owner, input.attemptId)).snapshot).toMatchObject({
    status: 'completed',
    actualModel: routed,
  });
  const raw = sentRequest(routed);
  expect(occurrences(raw, 'running in the Glow app')).toBe(1);
  return raw;
}

test('under Auto, a Gateway reply names the routed model in its first system message', async () => {
  const sent = z
    .object({ messages: z.array(z.unknown()) })
    .parse(JSON.parse(await autoReply('kimi')));
  expect(sent.messages.slice(0, 2)).toEqual([
    {
      role: 'system',
      content: [
        { type: 'text', text: 'You are Kimi K3, running in the Glow app.' },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: userText }] },
  ]);
});

test('under Auto, a Responses reply names the routed model in its instructions', async () => {
  const sent = z
    .object({ instructions: z.unknown(), input: z.unknown() })
    .parse(JSON.parse(await autoReply('gpt-6.1-sol')));
  expect(sent).toEqual({
    instructions: 'You are GPT-6.1 Sol, running in the Glow app.',
    input: [textItem('user', userText)],
  });
});

test.each<RegistryKey>(['kimi', 'gpt-6.1-sol'])(
  'a %s reply sends its identity but never saves it into the checkpoint',
  async model => {
    const input = submission();
    const items = [textItem('user', userText)];
    const result = await providers(model).generate(
      input,
      model,
      { items, checkpoint: makeCheckpoint(model, input.userTurnId, items) },
      signal,
      () => Promise.resolve(),
      before,
      null,
    );
    expect(occurrences(sentRequest(model), 'running in the Glow app')).toBe(1);
    expect(result.checkpoint?.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.checkpoint)).not.toContain(
      'running in the Glow app',
    );
  },
);

test.each<[RegistryKey, string | undefined, string]>([
  ['kimi', 'moonshotai/kimi-k3-0905', 'moonshotai/kimi-k3-0905'],
  ['kimi', undefined, '-'],
  ['gpt-6.1-sol', undefined, 'gpt-6.1-sol-2026-09-15'],
])(
  'a finished %s reply logs the requested and answered model, never message text',
  async (model, reported, answered) => {
    gatewayModel = reported;
    const input = submission();
    await providers(model).generate(
      input,
      model,
      { items: [textItem('user', userText)], checkpoint: null },
      signal,
      () => Promise.resolve(),
      before,
      null,
    );
    const requested = model === 'kimi' ? 'moonshotai/kimi-k3' : 'gpt-6.1-sol';
    expect(info.mock.calls).toEqual([
      [
        `reply model attempt=${input.attemptId.slice(0, 8)} requested=${requested} answered=${answered}`,
      ],
    ]);
  },
);
