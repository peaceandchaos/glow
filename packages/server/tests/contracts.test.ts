import { randomBytes, randomUUID } from 'node:crypto';
import {
  decodeJson,
  sessionTokenSchema,
  submissionSchema,
  validateAncestry,
} from '../../../shared/contracts';
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

test.each([
  [31, false],
  [32, true],
  [33, false],
])(
  'the base64url of %i random bytes is a session token: %s',
  (bytes, valid) => {
    expect(
      sessionTokenSchema.safeParse(randomBytes(bytes).toString('base64url'))
        .success,
    ).toBe(valid);
  },
);

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
