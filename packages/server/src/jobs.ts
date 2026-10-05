import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  attemptSnapshotSchema,
  attemptStatusSchema,
  checkpointSchema,
  contractVersion,
  decodeJson,
  isTerminal,
  jobEventSchema,
  submissionSchema,
  validateAncestry,
  type AttemptSnapshot,
  type AttemptStatus,
  type ContextCheckpoint,
  type EventPayload,
  type JobEvent,
  type ModelKey,
  type Submission,
} from '../../../shared/contracts';
import type { Database, SqlConnection } from './database';
import { AttemptCancelled, RequestError } from './errors';

const storedJobSchema = z.strictObject({
  snapshot: attemptSnapshotSchema,
  runId: z.string().nullable(),
  claimId: z.string().nullable(),
  heartbeat: z.number(),
  providerStarted: z.boolean(),
});
export type StoredJob = z.infer<typeof storedJobSchema>;
const pollSchema = z.strictObject({
  status: attemptStatusSchema,
  heartbeat: z.number(),
  events: z.array(jobEventSchema),
});
export const staleAfterMs = 330_000;
type JobUpdate = {
  events?: EventPayload[];
  text?: string;
  reasoning?: string;
  status?: AttemptStatus;
  actualModel?: ModelKey;
  checkpoint?: ContextCheckpoint;
  error?: string;
};
export type Dispatcher = (owner: string, attemptId: string) => Promise<string>;

function newJob(input: Submission, now: number): StoredJob {
  return {
    runId: null,
    claimId: null,
    heartbeat: now,
    providerStarted: false,
    snapshot: {
      version: contractVersion,
      attemptId: input.attemptId,
      chatId: input.chatId,
      pathId: input.pathId,
      userTurnId: input.userTurnId,
      sequence: 0,
      status: 'accepted',
      actualModel: null,
      text: '',
      reasoning: '',
      error: null,
      checkpoint: null,
      cancelRequested: false,
      delivered: false,
    },
  };
}

async function readJob(
  db: SqlConnection,
  owner: string,
  attemptId: string,
  lock = false,
): Promise<StoredJob> {
  const result = await db.query(
    `SELECT jsonb_set(state, '{snapshot,checkpoint}', COALESCE(checkpoint, 'null'))::text AS data
     FROM chat_jobs WHERE owner = $1 AND attempt_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [owner, attemptId],
  );
  const row = result.rows[0];
  if (!row) throw new RequestError(404, 'Reply not found.');
  return decodeJson(storedJobSchema, row.data);
}

async function lockStateWithoutCheckpoint(
  db: SqlConnection,
  owner: string,
  attemptId: string,
): Promise<StoredJob> {
  const result = await db.query(
    'SELECT state::text AS data FROM chat_jobs WHERE owner = $1 AND attempt_id = $2 FOR UPDATE',
    [owner, attemptId],
  );
  const row = result.rows[0];
  if (!row) throw new RequestError(404, 'Reply not found.');
  return decodeJson(storedJobSchema, row.data);
}

async function readCheckpoint(
  db: SqlConnection,
  owner: string,
  attemptId: string,
): Promise<ContextCheckpoint | null> {
  const result = await db.query(
    'SELECT checkpoint::text AS data FROM chat_jobs WHERE owner = $1 AND attempt_id = $2',
    [owner, attemptId],
  );
  const data = result.rows[0]?.data;
  return data ? decodeJson(checkpointSchema, data) : null;
}

async function writeJob(
  db: SqlConnection,
  owner: string,
  job: StoredJob,
): Promise<void> {
  await db.query(
    'UPDATE chat_jobs SET state = $3::jsonb WHERE owner = $1 AND attempt_id = $2',
    [
      owner,
      job.snapshot.attemptId,
      JSON.stringify({
        ...job,
        snapshot: { ...job.snapshot, checkpoint: null },
      }),
    ],
  );
}

async function appendEvents(
  db: SqlConnection,
  owner: string,
  job: StoredJob,
  payloads: EventPayload[],
): Promise<JobEvent[]> {
  const events: JobEvent[] = [];
  for (const payload of payloads) {
    job.snapshot.sequence += 1;
    const event = jobEventSchema.parse({
      ...payload,
      version: contractVersion,
      attemptId: job.snapshot.attemptId,
      sequence: job.snapshot.sequence,
    });
    if (event.kind === 'snapshot') {
      event.snapshot.sequence = event.sequence;
    }
    events.push(event);
  }
  if (events.length > 0) {
    await db.query(
      `INSERT INTO chat_job_events (owner, attempt_id, sequence, event)
       SELECT $1, $2::uuid, (item->>'sequence')::bigint, item
       FROM jsonb_array_elements($3::jsonb) AS item`,
      [owner, job.snapshot.attemptId, JSON.stringify(events)],
    );
  }
  await writeJob(db, owner, job);
  return events;
}

export class JobRepository {
  constructor(
    readonly database: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async submit(
    owner: string,
    input: Submission,
    dispatch: Dispatcher,
  ): Promise<StoredJob> {
    try {
      validateAncestry(input);
    } catch {
      throw new RequestError(400, 'Conversation ancestry is inconsistent.');
    }
    const serialized = JSON.stringify(input);
    const fingerprint = createHash('sha256').update(serialized).digest('hex');
    return this.database.transaction(async db => {
      // A transaction-scoped lock also covers a chat deletion racing a new send.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        owner + input.chatId,
      ]);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        owner + input.attemptId,
      ]);
      const cancelled = await db.query(
        'SELECT attempt_id::text AS data FROM cancelled_attempts WHERE owner = $1 AND attempt_id = $2',
        [owner, input.attemptId],
      );
      if (cancelled.rows.length)
        throw new RequestError(
          410,
          'This reply was stopped before acceptance.',
        );
      const deleted = await db.query(
        'SELECT chat_id::text AS data FROM deleted_chats WHERE owner = $1 AND chat_id = $2',
        [owner, input.chatId],
      );
      if (deleted.rows.length > 0)
        throw new RequestError(410, 'This chat was deleted.');
      const previous = await db.query(
        'SELECT request_hash AS data FROM chat_jobs WHERE owner = $1 AND attempt_id = $2',
        [owner, input.attemptId],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].data !== fingerprint) {
          throw new RequestError(
            409,
            'This reply id already belongs to a different request.',
          );
        }
        return readJob(db, owner, input.attemptId, true);
      }
      const active = await db.query(
        `SELECT attempt_id::text AS data FROM chat_jobs
         WHERE owner = $1 AND chat_id = $2 AND path_id = $3
           AND state->'snapshot'->>'status' IN
             ('accepted', 'selecting', 'compacting', 'generating')`,
        [owner, input.chatId, input.pathId],
      );
      if (active.rows.length > 0) {
        throw new RequestError(
          409,
          'This conversation path already has a reply in progress.',
        );
      }
      const job = newJob(input, this.now());
      await db.query(
        `INSERT INTO chat_jobs
           (owner, attempt_id, chat_id, path_id, request_hash, input, state)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [
          owner,
          input.attemptId,
          input.chatId,
          input.pathId,
          fingerprint,
          serialized,
          JSON.stringify(job),
        ],
      );
      // Acceptance is returned only after durable dispatch AND this transaction commit.
      // A dispatch whose acknowledgement is lost can run twice; claim() guards paid work.
      job.runId = await dispatch(owner, input.attemptId);
      await writeJob(db, owner, job);
      return job;
    });
  }

  get(owner: string, attemptId: string): Promise<StoredJob> {
    return readJob(this.database, owner, attemptId);
  }

  async input(owner: string, attemptId: string): Promise<Submission> {
    const result = await this.database.query(
      'SELECT input::text AS data FROM chat_jobs WHERE owner = $1 AND attempt_id = $2 AND input IS NOT NULL',
      [owner, attemptId],
    );
    const row = result.rows[0];
    if (!row)
      throw new RequestError(404, 'Reply input is no longer available.');
    return decodeJson(submissionSchema, row.data);
  }

  async claim(
    owner: string,
    attemptId: string,
    runId: string,
    claimId: string,
  ): Promise<boolean> {
    return this.database.transaction(async db => {
      const job = await lockStateWithoutCheckpoint(db, owner, attemptId);
      if (
        job.claimId ||
        isTerminal(job.snapshot.status) ||
        job.snapshot.cancelRequested
      )
        return false;
      job.claimId = claimId;
      job.runId = runId;
      job.heartbeat = this.now();
      await writeJob(db, owner, job);
      return true;
    });
  }

  async heartbeat(
    owner: string,
    attemptId: string,
    claimId: string,
  ): Promise<boolean> {
    return this.database.transaction(async db => {
      const job = await lockStateWithoutCheckpoint(db, owner, attemptId);
      if (
        job.claimId !== claimId ||
        job.snapshot.cancelRequested ||
        isTerminal(job.snapshot.status)
      )
        return false;
      job.heartbeat = this.now();
      await writeJob(db, owner, job);
      return true;
    });
  }

  async markProviderStarted(
    owner: string,
    attemptId: string,
    claimId: string,
  ): Promise<void> {
    await this.database.transaction(async db => {
      const job = await lockStateWithoutCheckpoint(db, owner, attemptId);
      this.assertActive(job, claimId);
      job.providerStarted = true;
      job.heartbeat = this.now();
      await writeJob(db, owner, job);
    });
  }

  private assertActive(job: StoredJob, claimId: string): void {
    if (
      job.claimId !== claimId ||
      job.snapshot.cancelRequested ||
      isTerminal(job.snapshot.status)
    ) {
      throw new AttemptCancelled();
    }
  }

  async update(
    owner: string,
    attemptId: string,
    claimId: string,
    update: JobUpdate,
  ): Promise<JobEvent[]> {
    return this.database.transaction(async db => {
      const job = await lockStateWithoutCheckpoint(db, owner, attemptId);
      this.assertActive(job, claimId);
      if (update.text) job.snapshot.text += update.text;
      if (update.reasoning) job.snapshot.reasoning += update.reasoning;
      if (update.status) job.snapshot.status = update.status;
      if (update.actualModel) job.snapshot.actualModel = update.actualModel;
      if (update.error) job.snapshot.error = update.error;
      job.heartbeat = this.now();
      if (update.checkpoint)
        await db.query(
          'UPDATE chat_jobs SET checkpoint = $3::jsonb WHERE owner = $1 AND attempt_id = $2',
          [owner, attemptId, JSON.stringify(update.checkpoint)],
        );
      const payloads = [...(update.events ?? [])];
      if (update.status || update.actualModel) {
        payloads.push({
          kind: 'status',
          status: job.snapshot.status,
          actualModel: job.snapshot.actualModel,
        });
      }
      if (isTerminal(job.snapshot.status)) {
        job.snapshot.checkpoint =
          update.checkpoint ?? (await readCheckpoint(db, owner, attemptId));
        payloads.push({ kind: 'snapshot', snapshot: { ...job.snapshot } });
      }
      return appendEvents(db, owner, job, payloads);
    });
  }

  async poll(
    owner: string,
    attemptId: string,
    after: number,
    staleAfterMs: number,
  ): Promise<{ events: JobEvent[]; endedOrStale: boolean }> {
    const result = await this.database.query(
      `SELECT jsonb_build_object(
         'status', state->'snapshot'->'status',
         'heartbeat', state->'heartbeat',
         'events', COALESCE((SELECT jsonb_agg(event ORDER BY sequence) FROM (
           SELECT event, sequence FROM chat_job_events
           WHERE owner = $1 AND attempt_id = $2 AND sequence > $3
           ORDER BY sequence LIMIT 500) page), '[]'))::text AS data
       FROM chat_jobs WHERE owner = $1 AND attempt_id = $2`,
      [owner, attemptId, after],
    );
    const row = result.rows[0];
    if (!row) throw new RequestError(404, 'Reply not found.');
    const page = decodeJson(pollSchema, row.data);
    return {
      events: page.events,
      endedOrStale:
        isTerminal(page.status) || this.now() - page.heartbeat > staleAfterMs,
    };
  }

  async requestCancellation(
    owner: string,
    attemptId: string,
  ): Promise<AttemptSnapshot | null> {
    // Serialize Stop against submission, including a handoff still in flight.
    return this.database.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        owner + attemptId,
      ]);
      const job = await readJob(db, owner, attemptId, true).catch(error => {
        if (error instanceof RequestError && error.status === 404) return null;
        throw error;
      });
      if (!job) {
        await db.query(
          'INSERT INTO cancelled_attempts (owner, attempt_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [owner, attemptId],
        );
        return null;
      }
      if (isTerminal(job.snapshot.status)) return job.snapshot;
      job.snapshot.cancelRequested = true;
      job.snapshot.status = 'stopped';
      await appendEvents(db, owner, job, [
        { kind: 'snapshot', snapshot: { ...job.snapshot } },
      ]);
      return job.snapshot;
    });
  }

  async acknowledge(
    owner: string,
    attemptId: string,
    sequence: number,
  ): Promise<void> {
    await this.database.transaction(async db => {
      const job = await lockStateWithoutCheckpoint(db, owner, attemptId);
      if (
        !isTerminal(job.snapshot.status) ||
        sequence !== job.snapshot.sequence
      ) {
        throw new RequestError(
          409,
          'Save the final reply before acknowledging it.',
        );
      }
      job.snapshot.delivered = true;
      job.snapshot.text = '';
      job.snapshot.reasoning = '';
      job.snapshot.error = null;
      await writeJob(db, owner, job);
      await db.query(
        'UPDATE chat_jobs SET input = NULL, checkpoint = NULL WHERE owner = $1 AND attempt_id = $2',
        [owner, attemptId],
      );
      await db.query(
        'DELETE FROM chat_job_events WHERE owner = $1 AND attempt_id = $2',
        [owner, attemptId],
      );
    });
  }

  async deleteChat(owner: string, chatId: string): Promise<void> {
    await this.database.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        owner + chatId,
      ]);
      await db.query(
        'INSERT INTO deleted_chats (owner, chat_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [owner, chatId],
      );
      await db.query(
        'DELETE FROM chat_input_parts WHERE owner = $1 AND chat_id = $2',
        [owner, chatId],
      );
      await db.query(
        `UPDATE chat_jobs SET input = NULL, checkpoint = NULL,
           state = jsonb_set(state, '{snapshot}', state->'snapshot' ||
             '{"status":"deleted","cancelRequested":true,"text":"","reasoning":"","checkpoint":null,"error":null}')
         WHERE owner = $1 AND chat_id = $2`,
        [owner, chatId],
      );
      await db.query(
        `DELETE FROM chat_job_events WHERE owner = $1 AND attempt_id IN
           (SELECT attempt_id FROM chat_jobs WHERE owner = $1 AND chat_id = $2)`,
        [owner, chatId],
      );
    });
  }

  async reconcile(
    owner: string,
    attemptId: string,
    staleAfterMs: number,
  ): Promise<StoredJob> {
    return this.database.transaction(async db => {
      const job = await readJob(db, owner, attemptId, true);
      if (
        !isTerminal(job.snapshot.status) &&
        this.now() - job.heartbeat > staleAfterMs
      ) {
        job.snapshot.status = 'interrupted';
        job.snapshot.error = job.providerStarted
          ? 'The worker stopped before it could confirm completion. Retry creates a new answer.'
          : 'The job could not finish. Retry creates a new answer.';
        await appendEvents(db, owner, job, [
          { kind: 'snapshot', snapshot: { ...job.snapshot } },
        ]);
      }
      return job;
    });
  }
}
