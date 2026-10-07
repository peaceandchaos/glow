import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import type { ResponseInputItem } from '../../../shared/contracts';
import { textItem } from '../src/compaction/context';
import { ProviderFailure } from '../src/errors';
import { GatewayClient, gatewayMessages } from '../src/gateway';
import { JevClient } from '../src/jev';
import type { ProviderChunk } from '../src/provider';
import { models, type Effort } from '../src/models';
import { LiveProviders } from '../src/providers';
import { ResponsesClient, trimCompacted } from '../src/responses';
import { exampleGatewayAuth, submission } from './fixtures';

const before = () => Promise.resolve();
const input = [textItem('user', 'Hello')];
const signal = new AbortController().signal;

function chunk(content: string | null, finish: string | null = null): string {
  return JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  });
}

function fakeGateway(
  records: string[],
  requests: RequestInit[],
): GatewayClient {
  return new GatewayClient({
    auth: exampleGatewayAuth,
    fetcher: (_url, init) => {
      if (init) requests.push(init);
      const bytes = new TextEncoder().encode(
        records.map(raw => `data: ${raw}\r\n\r\n`).join(''),
      );
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              for (let index = 0; index < bytes.length; index += 7)
                controller.enqueue(bytes.slice(index, index + 7));
              controller.close();
            },
          }),
        ),
      );
    },
  });
}

test('Gateway sends only its fixed model and emits a split UTF-8 stream once', async () => {
  const requests: RequestInit[] = [];
  const client = fakeGateway(
    [chunk('Hi 🦋'), chunk(null, 'stop'), '[DONE]'],
    requests,
  );
  const received: ProviderChunk[] = [];
  const answer = await client.generate(
    'kimi',
    input,
    signal,
    before,
    event => {
      received.push(event);
      return Promise.resolve();
    },
    null,
  );
  expect(answer).toBe('Hi 🦋');
  expect(requests).toHaveLength(1);
  expect(requests[0].body).toContain('moonshotai/kimi-k3');
  expect(requests[0].signal).toBe(signal);
  expect(received.flatMap(event => event.text ?? []).join('')).toBe(answer);
});

test.each([
  ['truncated', [chunk('Partial')]],
  ['missing its stop', [chunk('Partial'), '[DONE]']],
  ['length-limited', [chunk('Partial'), chunk(null, 'length'), '[DONE]']],
  ['empty', [chunk(null, 'stop'), '[DONE]']],
])('Gateway rejects a stream that is %s', async (_name, records) => {
  const requests: RequestInit[] = [];
  const client = fakeGateway(records, requests);
  await expect(
    client.generate(
      'deepseek',
      input,
      signal,
      before,
      () => Promise.resolve(),
      null,
    ),
  ).rejects.toBeInstanceOf(ProviderFailure);
  expect(requests).toHaveLength(1);
});

test('a Gateway connection lost mid-stream is an uncertain interruption', async () => {
  const record = new TextEncoder().encode(`data: ${chunk('Partial')}\r\n\r\n`);
  let pulls = 0;
  const client = new GatewayClient({
    auth: exampleGatewayAuth,
    fetcher: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) controller.enqueue(record);
              else controller.error(new TypeError('terminated'));
            },
          }),
        ),
      ),
  });
  const received: string[] = [];
  const result = client.generate(
    'kimi',
    input,
    signal,
    before,
    event => {
      received.push(event.text ?? '');
      return Promise.resolve();
    },
    null,
  );
  await expect(result).rejects.toBeInstanceOf(ProviderFailure);
  await expect(result).rejects.toMatchObject({ uncertain: true });
  expect(received).toEqual(['Partial']);
});

test('Gateway sends a reasoning effort only when one is chosen', async () => {
  const requests: RequestInit[] = [];
  const sent = async (effort: Effort | null) => {
    await fakeGateway(
      [chunk('Hi'), chunk(null, 'stop'), '[DONE]'],
      requests,
    ).generate(
      'deepseek',
      input,
      signal,
      before,
      () => Promise.resolve(),
      effort,
    );
    const body = requests.at(-1)?.body;
    return z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(typeof body === 'string' ? body : ''));
  };
  expect(await sent(null)).not.toHaveProperty('reasoning');
  expect((await sent('high')).reasoning).toEqual({ effort: 'high' });
});

test.each(['kimi', 'deepseek'] as const)(
  'a %s context summary asks for the lowest reasoning effort',
  async model => {
    const requests: RequestInit[] = [];
    const providers = new LiveProviders(
      new ResponsesClient({
        apiKey: 'example-key',
        socketUrl: 'ws://127.0.0.1:9',
      }),
      fakeGateway(
        [chunk('Earlier context.'), chunk(null, 'stop'), '[DONE]'],
        requests,
      ),
      new JevClient(exampleGatewayAuth, () =>
        Promise.reject(new Error('A summary must not call Jev')),
      ),
    );
    const turn = submission();
    let parentId: string | null = null;
    turn.history = Array.from({ length: 9 }, (_, index) => {
      const id = randomUUID();
      const entry = {
        id,
        parentId,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        text: `${index}: ${'A'.repeat(100_000)}`,
        images: [],
        complete: true,
      };
      parentId = id;
      return entry;
    });
    turn.userTurnId = turn.history[8].id;
    await providers.prepare(turn, model, signal, before);
    expect(requests).toHaveLength(1);
    const body = requests[0].body;
    expect(
      z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(typeof body === 'string' ? body : '')).reasoning,
    ).toEqual({ effort: models[model].levels[0] });
    expect(models[model].levels[0]).toBe('none');
  },
);

test('OpenAI opaque context is never translated into a Gateway request', () => {
  expect(() =>
    gatewayMessages([{ type: 'compaction', encrypted_content: 'opaque' }]),
  ).toThrow('cannot read');
});

test('Responses uses a real socket, store:false, and receives official compaction', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture address missing');
  const requests: string[] = [];
  server.on('connection', socket => {
    socket.on('message', data => {
      requests.push(
        Buffer.isBuffer(data) ? data.toString('utf8') : '<non-buffer>',
      );
      socket.send(
        JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'A reply',
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'response-example',
            status: 'completed',
            output: [
              { type: 'compaction', encrypted_content: 'opaque' },
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  { type: 'output_text', text: 'A reply', annotations: [] },
                ],
              },
            ],
          },
        }),
      );
    });
  });
  try {
    const client = new ResponsesClient({
      apiKey: 'example-key',
      socketUrl: `ws://127.0.0.1:${address.port}`,
    });
    const received: ProviderChunk[] = [];
    const result = await client.generate(
      models['gpt-6.1-sol'],
      input,
      signal,
      before,
      event => {
        received.push(event);
        return Promise.resolve();
      },
      null,
    );
    await client.generate(
      models['gpt-6-astra'],
      input,
      signal,
      before,
      () => Promise.resolve(),
      'high',
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain('"store":false');
    expect(requests[0]).not.toContain('previous_response_id');
    // OpenAI compacts both GPT models at 200,000
    // tokens, below the 272,000-token long-context price boundary.
    expect(
      requests.map(raw => {
        const sent = z
          .object({ model: z.string(), context_management: z.unknown() })
          .parse(JSON.parse(raw));
        return [sent.model, sent.context_management];
      }),
    ).toEqual([
      ['gpt-6.1-sol', [{ type: 'compaction', compact_threshold: 200_000 }]],
      ['gpt-6-astra', [{ type: 'compaction', compact_threshold: 200_000 }]],
    ]);
    expect(
      requests.map(
        raw =>
          z.object({ reasoning: z.unknown() }).parse(JSON.parse(raw)).reasoning,
      ),
    ).toEqual([{ summary: 'auto' }, { summary: 'auto', effort: 'high' }]);
    expect(result[0]).toEqual({
      type: 'compaction',
      encrypted_content: 'opaque',
    });
    expect(received[0].text).toBe('A reply');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('standalone compaction keeps its entire canonical replacement window', async () => {
  const output: ResponseInputItem[] = [
    textItem('user', 'retained prefix'),
    { type: 'compaction', encrypted_content: 'opaque' },
    textItem('user', 'tail'),
  ];
  const requests: RequestInit[] = [];
  const client = new ResponsesClient({
    apiKey: 'example-key',
    fetcher: (_url, init) => {
      if (init) requests.push(init);
      return Promise.resolve(Response.json({ output }));
    },
  });
  const config = models['gpt-6.1-sol'];
  expect(await client.compact(config, input, signal, before)).toEqual(output);
  expect(requests.map(request => request.body)).toEqual([
    JSON.stringify({ model: config.id, input }),
  ]);
  expect(trimCompacted([...input, ...output])).toEqual(output.slice(1));
});

test('Jev uses one evaluation with no retry and propagates AbortSignal', async () => {
  let calls = 0;
  let aborted = false;
  const controller = new AbortController();
  const fetcher: typeof fetch = (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
      controller.abort();
    });
  };
  const client = new JevClient(exampleGatewayAuth, fetcher);
  await expect(
    client.select(submission(), controller.signal, before, ['deepseek']),
  ).rejects.toThrow();
  expect(aborted).toBe(true);
  expect(calls).toBe(1);
});

test('Jev 500 failures do not trigger a second paid call', async () => {
  let calls = 0;
  const client = new JevClient(exampleGatewayAuth, () => {
    calls += 1;
    return Promise.resolve(
      Response.json({ error: 'Fixture failure' }, { status: 500 }),
    );
  });
  await expect(
    client.select(submission(), signal, before, ['deepseek']),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test('Jev sees only the offered models and refuses any other answer', async () => {
  const bodies: string[] = [];
  const jev = (choice: string) =>
    new JevClient(exampleGatewayAuth, (_url, init) => {
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(
        Response.json({ answers: { model: { type: 'choice', choice } } }),
      );
    });
  expect(
    await jev('kimi').select(submission(), signal, before, [
      'kimi',
      'gpt-6.1-sol',
    ]),
  ).toBe('kimi');
  const sent = z
    .object({
      questions: z.object({
        model: z.object({ criteria: z.record(z.string(), z.string()) }),
      }),
    })
    .parse(JSON.parse(bodies[0]));
  expect(Object.keys(sent.questions.model.criteria)).toEqual([
    'kimi',
    'gpt-6.1-sol',
  ]);
  await expect(
    jev('deepseek').select(submission(), signal, before, ['kimi']),
  ).rejects.toThrow();
});
