import { randomUUID } from 'node:crypto';
import type {
  HistoryEntry,
  ResponseInputItem,
} from '../../../shared/contracts';
import {
  contextSize,
  makeCheckpoint,
  prepareContext,
  textItem,
  type ContextServices,
} from '../src/compaction/context';
import type { ModelConfig } from '../src/models';
import { submission } from './fixtures';

const signal = new AbortController().signal;
const before = () => Promise.resolve();
const config: ModelConfig = {
  id: 'fixture',
  wire: 'gateway',
  window: 120_000,
  maxOutput: 8192,
  threshold: 40_000,
};
const responsesConfig: ModelConfig = {
  ...config,
  wire: 'responses',
  compactThreshold: 20_000,
};

function history(texts: string[]): HistoryEntry[] {
  let parentId: string | null = null;
  return texts.map((text, index) => {
    const id = randomUUID();
    const entry: HistoryEntry = {
      id,
      parentId,
      text,
      images: [],
      complete: true,
      role: index % 2 === 0 ? 'user' : 'assistant',
    };
    parentId = id;
    return entry;
  });
}

function services(calls: ResponseInputItem[][]): ContextServices {
  return {
    summarize: (_model, items) => {
      calls.push(items);
      return Promise.resolve('A valid earlier context summary.');
    },
    compactOpenAI: (_config, items) => {
      calls.push(items);
      return Promise.resolve([
        { type: 'compaction', encrypted_content: 'opaque-checkpoint' },
      ]);
    },
  };
}

test('Kimi compaction leaves the visible archive intact and retains its two recent messages', async () => {
  const input = submission();
  input.history = history(
    Array.from({ length: 7 }, (_, index) => `${index}: ${'A'.repeat(9000)}`),
  );
  input.userTurnId = input.history[6].id;
  const original = JSON.stringify(input.history);
  const calls: ResponseInputItem[][] = [];
  const prepared = await prepareContext(
    input,
    'kimi',
    signal,
    before,
    services(calls),
    config,
  );
  expect(calls.length).toBeGreaterThan(0);
  expect(contextSize(prepared.items)).toBeLessThan(config.threshold);
  expect(JSON.stringify(prepared.items)).toContain('6: ');
  expect(prepared.checkpoint?.throughMessageId).toBe(input.userTurnId);
  expect(JSON.stringify(input.history)).toBe(original);
});

test('DeepSeek uses its prefix summary and retained tail without replaying an incomplete answer', async () => {
  const input = submission();
  input.history = history(
    Array.from({ length: 9 }, (_, index) => `${index}: ${'B'.repeat(9000)}`),
  );
  input.history[3].complete = false;
  input.history[3].text = 'DO NOT REPLAY PARTIAL';
  input.userTurnId = input.history[8].id;
  const calls: ResponseInputItem[][] = [];
  const prepared = await prepareContext(
    input,
    'deepseek',
    signal,
    before,
    services(calls),
    config,
  );
  expect(calls.length).toBeGreaterThan(0);
  expect(JSON.stringify(calls)).not.toContain('DO NOT REPLAY PARTIAL');
  expect(JSON.stringify(prepared.items)).toContain('<compacted-summary>');
  expect(JSON.stringify(prepared.items)).toContain('8: ');
});

test('switching providers rebuilds from originals; same-provider checkpoints include intervening models', async () => {
  const input = submission();
  input.history = history([
    'First request',
    'GPT answer',
    'Next request',
    'Kimi answer',
    'Current question',
  ]);
  input.userTurnId = input.history[4].id;
  input.checkpoints = [
    makeCheckpoint('gpt-6.1-sol', input.history[1].id, [
      { type: 'compaction', encrypted_content: 'GPT ONLY' },
    ]),
  ];
  const calls: ResponseInputItem[][] = [];
  const kimi = await prepareContext(
    input,
    'kimi',
    signal,
    before,
    services(calls),
  );
  const gpt = await prepareContext(
    input,
    'gpt-6.1-sol',
    signal,
    before,
    services(calls),
  );
  expect(JSON.stringify(kimi.items)).toContain('First request');
  expect(JSON.stringify(kimi.items)).not.toContain('GPT ONLY');
  expect(JSON.stringify(gpt.items)).toContain('GPT ONLY');
  expect(JSON.stringify(gpt.items)).toContain('Kimi answer');
  expect(calls).toHaveLength(0);
});

test('a checkpoint from a sibling branch is rejected before any model call', async () => {
  const input = submission();
  input.checkpoints = [
    makeCheckpoint('kimi', randomUUID(), [textItem('user', 'Other branch')]),
  ];
  const calls: ResponseInputItem[][] = [];
  await expect(
    prepareContext(input, 'kimi', signal, before, services(calls)),
  ).rejects.toThrow('conversation path');
  expect(calls).toHaveLength(0);
});

test('oversized original text is processed in bounded windows without deleting it', async () => {
  const input = submission();
  input.history[0].text = '你好🦋'.repeat(12_000);
  const calls: ResponseInputItem[][] = [];
  const original = input.history[0].text;
  const prepared = await prepareContext(
    input,
    'gpt-6.1-sol',
    signal,
    before,
    services(calls),
    responsesConfig,
  );
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.every(items => contextSize(items) < config.threshold)).toBe(
    true,
  );
  expect(prepared.checkpoint?.method).toBe('openai-compaction');
  expect(input.history[0].text).toBe(original);
});

test('text that JSON escapes heavily is still split into pieces below the threshold', async () => {
  const input = submission();
  input.history[0].text = '\u0001'.repeat(12_000);
  const calls: ResponseInputItem[][] = [];
  const prepared = await prepareContext(
    input,
    'gpt-6.1-sol',
    signal,
    before,
    services(calls),
    responsesConfig,
  );
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(items => contextSize(items) < config.threshold)).toBe(
    true,
  );
  expect(prepared.checkpoint?.method).toBe('openai-compaction');
});

test('an empty or ineffective compaction fails without silently truncating history', async () => {
  const input = submission();
  input.history = history(Array.from({ length: 5 }, () => 'C'.repeat(9000)));
  input.userTurnId = input.history[4].id;
  const calls: ResponseInputItem[][] = [];
  await expect(
    prepareContext(
      input,
      'kimi',
      signal,
      before,
      { ...services(calls), summarize: () => Promise.resolve('') },
      config,
    ),
  ).rejects.toThrow('empty summary');
  await expect(
    prepareContext(
      input,
      'gpt-6.1-sol',
      signal,
      before,
      {
        ...services(calls),
        compactOpenAI: (_config, items) => Promise.resolve(items),
      },
      responsesConfig,
    ),
  ).rejects.toThrow('did not free');
});

test('an image counts by its per-image estimate, not its encoded length', async () => {
  const photo = (characters: number): ResponseInputItem => ({
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_image',
        image_url: `data:image/png;base64,${'A'.repeat(characters)}`,
      },
    ],
  });
  const empty = contextSize([{ type: 'message', role: 'user', content: [] }]);
  // OpenAI's documented ceiling: 30,000 patches at the 1.2 multiplier.
  expect(contextSize([photo(4)]) - empty).toBeGreaterThanOrEqual(
    Math.ceil(30_000 * 1.2),
  );
  expect(contextSize([photo(2_999_000)])).toBe(contextSize([photo(4)]));

  // Small encoded images still fill the window and lead to compaction.
  const input = submission();
  input.history = history(Array.from({ length: 13 }, (_, index) => `${index}`));
  for (const entry of input.history)
    if (entry.role === 'user')
      entry.images = Array.from(
        { length: 4 },
        () => 'data:image/png;base64,AAAA',
      );
  input.userTurnId = input.history[12].id;
  const calls: ResponseInputItem[][] = [];
  const prepared = await prepareContext(
    input,
    'kimi',
    signal,
    before,
    services(calls),
  );
  expect(calls.length).toBeGreaterThan(0);
  expect(prepared.checkpoint?.method).toBe('kimi-summary');
});
