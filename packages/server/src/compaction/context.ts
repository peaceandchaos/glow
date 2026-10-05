import type {
  ContextCheckpoint,
  HistoryEntry,
  ModelKey,
  ResponseInputItem,
  Submission,
} from '../../../../shared/contracts';
import { ProviderFailure } from '../errors';
import {
  checkpointMethod,
  models,
  type ModelConfig,
  type ResponsesModel,
} from '../models';
import type { BeforePaidCall, PreparedContext } from '../provider';
import {
  kimiInstruction,
  deepseekInstruction,
  deepseekPreamble,
} from './instructions';

export type ContextServices = {
  compactOpenAI: (
    config: ResponsesModel,
    items: ResponseInputItem[],
    signal: AbortSignal,
    beforeCall: BeforePaidCall,
  ) => Promise<ResponseInputItem[]>;
  summarize: (
    model: ModelKey,
    items: ResponseInputItem[],
    signal: AbortSignal,
    beforeCall: BeforePaidCall,
    maxOutput: number,
  ) => Promise<string>;
};

export function textItem(
  role: 'user' | 'assistant' | 'system',
  text: string,
): ResponseInputItem {
  return {
    type: 'message',
    role,
    content: [
      { type: role === 'assistant' ? 'output_text' : 'input_text', text },
    ],
  };
}

// Providers count an image by its dimensions, not its encoded bytes. This is the
// largest per-image cost documented for the configured models: OpenAI's
// 30,000-patch limit at its 1.2 multiplier. Sources are in docs/providers.md.
const imageEstimate = 36_000;

// A byte upper estimate protects multilingual text when provider tokenizers are
// unavailable. It intentionally compacts earlier than the CLI's chars/4 estimate.
function itemSize(item: ResponseInputItem): number {
  if (item.type !== 'message')
    return Buffer.byteLength(JSON.stringify(item), 'utf8') + 16;
  const text = item.content.filter(part => part.type !== 'input_image');
  const images = item.content.length - text.length;
  return (
    Buffer.byteLength(JSON.stringify({ ...item, content: text }), 'utf8') +
    16 +
    images * imageEstimate
  );
}

export function contextSize(items: ResponseInputItem[]): number {
  let size = 0;
  for (const item of items) size += itemSize(item);
  return size;
}

function* messagePieces(
  entry: HistoryEntry,
  maxBytes: number,
): Generator<ResponseInputItem> {
  if (entry.role === 'assistant' && !entry.complete) return;
  // Split only working input, never the visible record. UTF-8 code points stay
  // intact. Each point is measured as itemSize counts it, after JSON escaping.
  let text = '';
  let bytes = 0;
  for (const point of entry.text) {
    const length = Buffer.byteLength(JSON.stringify(point), 'utf8') - 2;
    if (bytes + length > maxBytes && text) {
      yield textItem(entry.role, text);
      text = '';
      bytes = 0;
    }
    text += point;
    bytes += length;
  }
  if (text) yield textItem(entry.role, text);
  for (const image of entry.images) {
    yield {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: image }],
    };
  }
}

function retainedStart(
  items: ResponseInputItem[],
  model: ModelKey,
  config: ModelConfig,
): number {
  if (model === 'kimi') return Math.max(0, items.length - 2);
  const target = (config.window - config.maxOutput) * 0.16;
  let size = 0;
  let start = items.length;
  while (start > 0 && size + itemSize(items[start - 1]) <= target) {
    start -= 1;
    size += itemSize(items[start]);
  }
  return start;
}

async function compact(
  items: ResponseInputItem[],
  model: ModelKey,
  config: ModelConfig,
  signal: AbortSignal,
  beforeCall: BeforePaidCall,
  services: ContextServices,
): Promise<ResponseInputItem[]> {
  if (config.wire === 'responses')
    return services.compactOpenAI(config, items, signal, beforeCall);
  const start = retainedStart(items, model, config);
  if (start === 0)
    throw new ProviderFailure(
      'The recent input is too large to compact safely. Shorten the input or attachment.',
    );
  const prefix = items.slice(0, start);
  const instruction = model === 'kimi' ? kimiInstruction : deepseekInstruction;
  const request =
    model === 'kimi'
      ? [
          textItem(
            'system',
            'You are a helpful assistant that compacts conversation context.',
          ),
          ...prefix,
          textItem('user', instruction),
        ]
      : [...prefix, textItem('user', instruction)];
  const summary = await services.summarize(
    model,
    request,
    signal,
    beforeCall,
    Math.min(config.maxOutput, 65_536),
  );
  signal.throwIfAborted();
  if (!summary.trim())
    throw new ProviderFailure('Context compaction returned an empty summary.');
  const framed =
    model === 'kimi'
      ? `Previous context has been compacted. Here is the compaction output:\n${summary}`
      : `${deepseekPreamble}\n\n<compacted-summary>\n${summary}\n</compacted-summary>`;
  return [textItem('user', framed), ...items.slice(start)];
}

export async function prepareContext(
  input: Submission,
  model: ModelKey,
  signal: AbortSignal,
  beforeCall: BeforePaidCall,
  services: ContextServices,
  config: ModelConfig = models[model],
): Promise<PreparedContext> {
  const checkpoint = input.checkpoints.find(item => item.model === model);
  let start = 0;
  let items: ResponseInputItem[] = [];
  let didCompact = false;
  if (checkpoint) {
    const anchor = input.history.findIndex(
      item => item.id === checkpoint.throughMessageId,
    );
    if (anchor < 0 || checkpoint.method !== checkpointMethod(model))
      throw new ProviderFailure(
        'The saved context does not match this conversation path.',
      );
    items = [...checkpoint.items];
    start = anchor + 1;
  }
  // Leave room for the compaction instruction and the model's completion budget.
  const threshold = Math.min(
    config.threshold,
    config.window - config.maxOutput - 65_536,
  );
  const pieceBudget = Math.floor(threshold / 4);
  if (threshold <= 0)
    throw new ProviderFailure('The model context configuration is invalid.');
  let size = contextSize(items);
  const shrink = async () => {
    const before = size;
    items = await compact(items, model, config, signal, beforeCall, services);
    didCompact = true;
    size = contextSize(items);
    if (size >= before)
      throw new ProviderFailure(
        'Context compaction did not free enough space. The original history is saved.',
      );
  };
  if (size >= threshold) await shrink();
  for (const entry of input.history.slice(start)) {
    for (const piece of messagePieces(entry, pieceBudget)) {
      signal.throwIfAborted();
      const pieceSize = itemSize(piece);
      if (pieceSize >= threshold)
        throw new ProviderFailure(
          'An attachment is too large for inline context. Use a smaller image.',
        );
      while (items.length > 0 && size + pieceSize >= threshold) await shrink();
      items.push(piece);
      size += pieceSize;
    }
  }
  return {
    items,
    checkpoint: didCompact
      ? makeCheckpoint(model, input.userTurnId, items)
      : null,
  };
}

export function makeCheckpoint(
  model: ModelKey,
  throughMessageId: string,
  items: ResponseInputItem[],
): ContextCheckpoint {
  return {
    model,
    throughMessageId,
    method: checkpointMethod(model),
    items,
    summary: '',
  };
}
