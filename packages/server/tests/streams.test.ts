import {
  parseGatewayEvent,
  parseResponsesEvent,
  SseDecoder,
} from '../../../shared/provider-events';

test('Gateway records survive every possible split, including CRLF and Unicode', () => {
  const text = `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hello 🌍' } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const bytes = new TextEncoder().encode(text);
  for (let index = 0; index <= bytes.length; index++) {
    const decoder = new TextDecoder();
    const sse = new SseDecoder();
    const records = [
      ...sse.push(decoder.decode(bytes.slice(0, index), { stream: true })),
      ...sse.push(decoder.decode(bytes.slice(index), { stream: true })),
      ...sse.push(decoder.decode()),
    ];
    sse.finish();
    expect(records.map(parseGatewayEvent)).toEqual([
      { kind: 'delta', text: 'Hello 🌍' },
      { kind: 'completed', responseId: '' },
    ]);
  }
});

test('SSE handles comments and multiline data, and rejects a truncated record', () => {
  const decoder = new SseDecoder();
  expect(decoder.push(': ping\n\ndata: first\ndata: second\n\n')).toEqual([
    'first\nsecond',
  ]);
  decoder.push('data: half');
  expect(() => decoder.finish()).toThrow('inside a record');
});

test('the SSE record cap holds however the record is chunked', () => {
  const record = `data: ${'x'.repeat(100)}\n\n`;
  expect(() => new SseDecoder(64).push(record)).toThrow('too large');
  const split = new SseDecoder(64);
  expect(() => {
    for (const piece of record.match(/.{1,10}/gsu) ?? []) split.push(piece);
  }).toThrow('too large');
});

test('both provider readers reject malformed trusted fields', () => {
  expect(() => parseResponsesEvent('{')).toThrow();
  expect(() =>
    parseResponsesEvent('{"type":"response.output_text.delta","delta":42}'),
  ).toThrow();
  expect(() => parseGatewayEvent('{"choices":[]}')).toThrow();
});

test('incomplete, failed and tool responses are visible errors', () => {
  expect(parseResponsesEvent('{"type":"response.incomplete"}').kind).toBe(
    'error',
  );
  expect(parseResponsesEvent('{"type":"response.failed"}').kind).toBe('error');
  expect(
    parseResponsesEvent(
      '{"type":"response.output_item.added","item":{"type":"function_call"}}',
    ).kind,
  ).toBe('error');
  expect(
    parseGatewayEvent(
      JSON.stringify({
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      }),
    ).kind,
  ).toBe('error');
});

test('GPT keeps text and published reasoning summaries separate', () => {
  expect(
    parseResponsesEvent(
      '{"type":"response.output_text.delta","delta":"Answer"}',
    ),
  ).toEqual({ kind: 'delta', text: 'Answer' });
  expect(
    parseResponsesEvent(
      '{"type":"response.reasoning_summary_text.delta","delta":"Summary"}',
    ),
  ).toEqual({ kind: 'reasoning', text: 'Summary' });
  expect(
    parseResponsesEvent(
      '{"type":"response.completed","response":{"id":"response_1","status":"completed"}}',
    ),
  ).toEqual({ kind: 'completed', responseId: 'response_1' });
});
