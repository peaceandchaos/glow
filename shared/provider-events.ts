import { z } from 'zod';
import { decodeJson } from './contracts';

// What the reply is doing before its text starts.
export type ReplyLabel = 'Thinking' | 'Responding';

export type ParsedProviderEvent =
  | { kind: 'status'; label: ReplyLabel }
  | { kind: 'delta'; text: string; stopped?: boolean }
  | { kind: 'reasoning'; text: string }
  | { kind: 'completed'; responseId: string }
  | { kind: 'error'; message: string }
  | { kind: 'ignored'; type: string };

const responsesEventSchema = z.object({
  type: z.string(),
  delta: z.string().optional(),
  item: z.object({ type: z.string() }).optional(),
  response: z
    .object({ id: z.string(), status: z.string().optional() })
    .optional(),
});

export function parseResponsesEvent(raw: string): ParsedProviderEvent {
  const event = decodeJson(responsesEventSchema, raw);
  switch (event.type) {
    case 'response.created':
    case 'response.in_progress':
      return { kind: 'status', label: 'Thinking' };
    case 'response.output_item.added':
      return outputItemStatus(event.item?.type);
    case 'response.reasoning_summary_text.delta':
      if (event.delta === undefined)
        throw new Error('Missing reasoning delta.');
      return { kind: 'reasoning', text: event.delta };
    case 'response.output_text.delta':
    case 'response.refusal.delta':
      if (event.delta === undefined) throw new Error('Missing text delta.');
      return { kind: 'delta', text: event.delta };
    case 'response.completed':
      if (!event.response?.id || event.response.status !== 'completed') {
        throw new Error('Invalid completed response.');
      }
      return { kind: 'completed', responseId: event.response.id };
    case 'response.failed':
    case 'error':
      return {
        kind: 'error',
        message: 'The provider could not finish this reply. You can retry.',
      };
    case 'response.incomplete':
      return {
        kind: 'error',
        message: 'The provider returned a limited answer. You can retry.',
      };
    case 'response.cancelled':
      return { kind: 'error', message: 'The provider stopped this reply.' };
    default:
      return { kind: 'ignored', type: event.type };
  }
}

function outputItemStatus(type: string | undefined): ParsedProviderEvent {
  if (type === 'message') return { kind: 'status', label: 'Responding' };
  if (type === 'reasoning') return { kind: 'status', label: 'Thinking' };
  if (type === 'function_call')
    return {
      kind: 'error',
      message: 'This version does not support model tools.',
    };
  return { kind: 'ignored', type: type ?? 'unknown' };
}

const gatewayChunkSchema = z.object({
  object: z.literal('chat.completion.chunk'),
  choices: z.array(
    z.object({
      index: z.number().int(),
      delta: z.object({ content: z.string().nullable().optional() }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
});

export function parseGatewayEvent(raw: string): ParsedProviderEvent {
  if (raw === '[DONE]') return { kind: 'completed', responseId: '' };
  const chunk = decodeJson(gatewayChunkSchema, raw);
  const choice = chunk.choices.find(item => item.index === 0);
  if (!choice) return { kind: 'ignored', type: 'usage' };
  if (choice.finish_reason && choice.finish_reason !== 'stop') {
    return {
      kind: 'error',
      message: 'The provider returned a limited answer. You can retry.',
    };
  }
  if (choice.delta.content)
    return {
      kind: 'delta',
      text: choice.delta.content,
      ...(choice.finish_reason === 'stop' ? { stopped: true } : {}),
    };
  return { kind: 'ignored', type: choice.finish_reason ?? 'metadata' };
}

function recordData(record: string): string | null {
  const data: string[] = [];
  for (const line of record.split(/\r?\n/u)) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
  }
  return data.length > 0 ? data.join('\n') : null;
}

// SSE records can split at any byte, newline, or JSON token. TextDecoder handles
// UTF-8 boundaries; this parser retains incomplete records between calls.
// A boundary that straddles two chunks starts at most this far before the new text.
const boundaryOverlap = '\r\n\r\n'.length - 1;

export class SseDecoder {
  private buffer = '';
  private boundaryFreeLength = 0;

  constructor(private readonly maxRecordCharacters = 1_048_576) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    const records: string[] = [];
    const boundary = /\r?\n\r?\n/gu;
    boundary.lastIndex = Math.max(0, this.boundaryFreeLength - boundaryOverlap);
    let start = 0;
    for (
      let match = boundary.exec(this.buffer);
      match;
      match = boundary.exec(this.buffer)
    ) {
      if (match.index - start > this.maxRecordCharacters)
        throw new Error('A stream record is too large.');
      const data = recordData(this.buffer.slice(start, match.index));
      if (data !== null) records.push(data);
      start = boundary.lastIndex;
    }
    this.buffer = this.buffer.slice(start);
    this.boundaryFreeLength = this.buffer.length;
    if (this.buffer.length > this.maxRecordCharacters)
      throw new Error('A stream record is too large.');
    return records;
  }

  finish(): void {
    if (this.buffer.trim())
      throw new Error('The stream ended inside a record.');
    this.buffer = '';
    this.boundaryFreeLength = 0;
  }
}
