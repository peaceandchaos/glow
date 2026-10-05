import { z } from 'zod';
import {
  contextPartCharacters,
  decodeJson,
  submissionSchema,
  type CommitInput,
  type ContextPart,
} from '../../../shared/contracts';
import { RequestError } from './errors';
import type { Dispatcher, JobRepository, StoredJob } from './jobs';

const partSchema = z.object({
  chatId: z.string(),
  parts: z.number(),
  characters: z.number(),
  content: z.string(),
});
const contentsSchema = z.array(
  z.object({
    index: z.number(),
    parts: z.number(),
    characters: z.number(),
    content: z.string(),
  }),
);

export class InputParts {
  constructor(private readonly jobs: JobRepository) {}

  async stage(owner: string, part: ContextPart): Promise<void> {
    if (
      part.parts !== Math.ceil(part.characters / contextPartCharacters) ||
      part.index >= part.parts
    )
      throw new RequestError(400, 'Invalid context part.');
    const expected =
      part.index === part.parts - 1
        ? part.characters - part.index * contextPartCharacters
        : contextPartCharacters;
    if (part.text.length !== expected)
      throw new RequestError(400, 'Incomplete context part.');
    await this.jobs.database.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        owner + part.chatId,
      ]);
      const deleted = await db.query(
        'SELECT chat_id::text AS data FROM deleted_chats WHERE owner = $1 AND chat_id = $2',
        [owner, part.chatId],
      );
      if (deleted.rows.length)
        throw new RequestError(410, 'This chat was deleted.');
      // Unaccepted partial submissions are not results. The phone can resend them.
      await db.query(
        "DELETE FROM chat_input_parts WHERE owner = $1 AND created_at < now() - interval '1 day'",
        [owner],
      );
      const previous = await db.query(
        `SELECT jsonb_build_object('chatId', chat_id, 'parts', parts, 'characters', characters, 'content', content)::text AS data
        FROM chat_input_parts WHERE owner = $1 AND attempt_id = $2 AND part_index = $3`,
        [owner, part.attemptId, part.index],
      );
      if (previous.rows[0]) {
        const saved = decodeJson(partSchema, previous.rows[0].data);
        if (
          saved.chatId !== part.chatId ||
          saved.parts !== part.parts ||
          saved.characters !== part.characters ||
          saved.content !== JSON.stringify(part.text)
        )
          throw new RequestError(
            409,
            'This context part already has different data.',
          );
        return;
      }
      await db.query(
        `INSERT INTO chat_input_parts (owner, attempt_id, chat_id, part_index, parts, characters, content)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          owner,
          part.attemptId,
          part.chatId,
          part.index,
          part.parts,
          part.characters,
          // JSON escapes a surrogate split at a part boundary. PostgreSQL UTF-8
          // text cannot store that isolated surrogate without replacing it.
          JSON.stringify(part.text),
        ],
      );
    });
  }

  async commit(
    owner: string,
    input: CommitInput,
    dispatch: Dispatcher,
  ): Promise<StoredJob> {
    const existing = await this.jobs
      .get(owner, input.attemptId)
      .catch(error => {
        if (error instanceof RequestError && error.status === 404) return null;
        throw error;
      });
    if (existing) {
      if (existing.snapshot.chatId !== input.chatId)
        throw new RequestError(409, 'This reply belongs to another chat.');
      return existing;
    }
    const result = await this.jobs.database.query(
      `SELECT COALESCE(jsonb_agg(jsonb_build_object('index', part_index, 'parts', parts, 'characters', characters, 'content', content) ORDER BY part_index), '[]'::jsonb)::text AS data
      FROM chat_input_parts WHERE owner = $1 AND attempt_id = $2 AND chat_id = $3`,
      [owner, input.attemptId, input.chatId],
    );
    const parts = decodeJson(contentsSchema, result.rows[0]?.data ?? '[]');
    if (
      parts.length !== input.parts ||
      parts.some(
        (part, index) =>
          part.index !== index ||
          part.parts !== input.parts ||
          part.characters !== input.characters,
      )
    )
      throw new RequestError(
        409,
        'Send all context parts before starting this reply.',
      );
    const text = parts
      .map(part => decodeJson(z.string(), part.content))
      .join('');
    if (text.length !== input.characters)
      throw new RequestError(400, 'Context length mismatch.');
    const submission = decodeJson(submissionSchema, text);
    if (
      submission.attemptId !== input.attemptId ||
      submission.chatId !== input.chatId
    )
      throw new RequestError(400, 'Context identity mismatch.');
    const job = await this.jobs.submit(owner, submission, dispatch);
    await this.jobs.database.query(
      'DELETE FROM chat_input_parts WHERE owner = $1 AND attempt_id = $2',
      [owner, input.attemptId],
    );
    return job;
  }
}
