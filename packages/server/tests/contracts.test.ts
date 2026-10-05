import { randomUUID } from 'node:crypto';
import {
  decodeJson,
  submissionSchema,
  validateAncestry,
} from '../../../shared/contracts';
import { deviceOwner } from '../src/auth';
import { submission } from './fixtures';

test('network input rejects malformed JSON, unknown models and an old contract', () => {
  expect(() => decodeJson(submissionSchema, '{')).toThrow();
  expect(() =>
    decodeJson(
      submissionSchema,
      JSON.stringify({ ...submission(), picker: 'arbitrary-model' }),
    ),
  ).toThrow();
  expect(() =>
    decodeJson(
      submissionSchema,
      JSON.stringify({ ...submission(), version: 0 }),
    ),
  ).toThrow();
});

test('ancestry validation rejects context from a sibling branch', () => {
  const input = submission();
  input.checkpoints.push({
    model: 'gpt-6.1-sol',
    throughMessageId: randomUUID(),
    method: 'openai-compaction',
    items: [],
    summary: '',
  });
  expect(() => validateAncestry(input)).toThrow('does not belong');
});

test('device admission requires the exact secure id and returns only its digest', () => {
  const device = 'a'.repeat(43);
  const headers = new Headers({ 'X-Device-Id': device });
  expect(() => deviceOwner(new Headers(), device)).toThrow();
  expect(() => deviceOwner(headers, 'b'.repeat(43))).toThrow();
  expect(deviceOwner(headers, device)).toMatch(/^[a-f0-9]{64}$/u);
  expect(deviceOwner(headers, device)).not.toContain(device);
});
