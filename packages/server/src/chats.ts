import {
  decodeJson,
  searchResponseSchema,
  syncPageSchema,
  type AttemptSnapshot,
  type SearchResponse,
  type SyncPage,
  type SyncPush,
} from '../../../shared/contracts';
import type { Database, SqlConnection } from './database';

const pageRows = 200;
const pageBytes = 1_000_000;
const searchHits = 20;
const titleWeight = 2;
const indexedCharacters = 100_000;

// The only producer of seq values. The chat_owners row lock is held until
// commit, so per-owner seq order is commit order and a pull cursor never
// skips a seq that commits later. Returns the seq just below the reserved block.
// Lock order: advisory locks, chat_jobs rows, the chat_owners row, then
// writes to chats, chat_messages and deleted_chats.seq. Stamp once per
// transaction.
async function stamp(
  db: SqlConnection,
  owner: string,
  ticks: number,
): Promise<number> {
  const result = await db.query(
    `INSERT INTO chat_owners (owner, seq) VALUES ($1, $2)
     ON CONFLICT (owner) DO UPDATE SET seq = chat_owners.seq + EXCLUDED.seq
     RETURNING seq::text AS data`,
    [owner, ticks],
  );
  return Number(result.rows[0].data) - ticks;
}

// Only to_tsquery supports prefix matching, and it rejects stray operators,
// so just runs of letters and digits reach it.
function prefixQuery(query: string): string {
  return (query.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(word => word.length >= 2)
    .slice(0, 8)
    .map(word => `${word}:*`)
    .join(' & ');
}

const tombstoned = (chatId: string) =>
  `EXISTS (SELECT 1 FROM deleted_chats d WHERE d.owner = $1 AND d.chat_id = ${chatId})`;

const levelField = (column: string) =>
  `CASE WHEN ${column} IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('level', ${column}) END`;

export class ChatRows {
  constructor(private readonly database: Database) {}

  async push(owner: string, batch: SyncPush): Promise<void> {
    const ticks = batch.messages.length + batch.chats.length;
    if (ticks === 0) return;
    await this.database.transaction(async db => {
      const base = await stamp(db, owner, ticks);
      await db.query(
        `INSERT INTO chat_messages (owner, id, seq, chat_id, parent_id, path_id,
           role, status, text, reasoning, image_count, picker, level,
           retry_model, actual_model, error, created_at)
         SELECT $1, (m->>'id')::uuid, $2::bigint + ord, (m->>'chatId')::uuid,
           (m->>'parentId')::uuid, (m->>'pathId')::uuid, m->>'role', m->>'status',
           m->>'text', m->>'reasoning', (m->>'imageCount')::smallint, m->>'picker',
           m->>'level', m->>'retryModel', m->>'actualModel', m->>'error',
           (m->>'createdAt')::bigint
         FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS e(m, ord)
         WHERE NOT ${tombstoned("(m->>'chatId')::uuid")}
         ON CONFLICT (owner, id) DO NOTHING`,
        [owner, base, JSON.stringify(batch.messages)],
      );
      // A field outside dirty keeps the stored value, so a stale push of
      // one field cannot rewind another device's edit of a different one.
      await db.query(
        `WITH r AS (
           SELECT (c->>'id')::uuid AS id, $2::bigint + ord AS seq, c->'dirty' AS dirty,
             c->>'title' AS title, c->>'picker' AS picker, c->>'level' AS level,
             (c->>'basePathId')::uuid AS base_path_id, (c->>'leafId')::uuid AS leaf_id,
             (c->>'createdAt')::bigint AS created_at, (c->>'updatedAt')::bigint AS updated_at
           FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS e(c, ord))
         INSERT INTO chats AS s (owner, id, seq, title, picker, level,
           base_path_id, leaf_id, created_at, updated_at)
         SELECT $1, r.id, r.seq,
           CASE WHEN o.id IS NULL OR r.dirty ? 'title' THEN r.title ELSE o.title END,
           CASE WHEN o.id IS NULL OR r.dirty ? 'model' THEN r.picker ELSE o.picker END,
           CASE WHEN o.id IS NULL OR r.dirty ? 'model' THEN r.level ELSE o.level END,
           r.base_path_id,
           CASE WHEN o.id IS NULL OR r.dirty ? 'leaf' THEN r.leaf_id ELSE o.leaf_id END,
           r.created_at,
           CASE WHEN r.dirty ? 'leaf' THEN GREATEST(o.updated_at, r.updated_at)
             ELSE COALESCE(o.updated_at, r.updated_at) END
         FROM r LEFT JOIN chats o ON o.owner = $1 AND o.id = r.id
         WHERE NOT ${tombstoned('r.id')}
         ON CONFLICT (owner, id) DO UPDATE SET seq = EXCLUDED.seq,
           title = EXCLUDED.title, picker = EXCLUDED.picker, level = EXCLUDED.level,
           leaf_id = EXCLUDED.leaf_id, updated_at = EXCLUDED.updated_at
         WHERE (s.title, s.picker, s.level, s.leaf_id, s.updated_at)
           IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.picker, EXCLUDED.level,
             EXCLUDED.leaf_id, EXCLUDED.updated_at)`,
        [owner, base + batch.messages.length, JSON.stringify(batch.chats)],
      );
    });
  }

  async pull(owner: string, after: number): Promise<SyncPage> {
    const result = await this.database.query(
      `WITH changes AS (
         SELECT seq, 'm' AS kind, jsonb_build_object('id', id, 'chatId', chat_id,
           'parentId', parent_id, 'pathId', path_id, 'role', role, 'status', status,
           'text', text, 'reasoning', reasoning, 'imageCount', image_count,
           'picker', picker, 'retryModel', retry_model, 'actualModel', actual_model,
           'error', error, 'createdAt', created_at) || ${levelField('level')} AS r
         FROM chat_messages WHERE owner = $1 AND seq > $2
         UNION ALL
         SELECT seq, 'c', jsonb_build_object('id', id, 'title', title, 'picker', picker,
           'basePathId', base_path_id, 'leafId', leaf_id, 'createdAt', created_at,
           'updatedAt', updated_at) || ${levelField('level')}
         FROM chats WHERE owner = $1 AND seq > $2
         UNION ALL
         SELECT seq, 'd', to_jsonb(chat_id) FROM deleted_chats WHERE owner = $1 AND seq > $2),
       page AS (
         SELECT seq, kind, r, row_number() OVER w AS n,
           sum(octet_length(r::text)) OVER w AS bytes
         FROM (SELECT * FROM changes ORDER BY seq LIMIT ${pageRows + 1}) c
         WINDOW w AS (ORDER BY seq)),
       kept AS (
         SELECT *, n <= ${pageRows} AND (n = 1 OR bytes <= ${pageBytes}) AS keep FROM page)
       SELECT jsonb_build_object(
         'chats', COALESCE(jsonb_agg(r ORDER BY seq) FILTER (WHERE keep AND kind = 'c'), '[]'),
         'messages', COALESCE(jsonb_agg(r ORDER BY seq) FILTER (WHERE keep AND kind = 'm'), '[]'),
         'deletedChatIds', COALESCE(jsonb_agg(r ORDER BY seq) FILTER (WHERE keep AND kind = 'd'), '[]'),
         'cursor', COALESCE(max(seq) FILTER (WHERE keep), $2),
         'more', COALESCE(bool_or(NOT keep), false))::text AS data
       FROM kept`,
      [owner, after],
    );
    return decodeJson(syncPageSchema, result.rows[0].data);
  }

  async search(owner: string, query: string): Promise<SearchResponse> {
    const terms = prefixQuery(query);
    if (!terms) return { hits: [] };
    // ts_headline reparses the whole text, so it runs only on the returned hits.
    const result = await this.database.query(
      `WITH query AS (SELECT to_tsquery('simple', $2) AS q),
       hits AS (
         SELECT chat_id, id AS message_id, ts_rank_cd(search, q) AS rank
         FROM chat_messages, query WHERE owner = $1 AND search @@ q
         UNION ALL
         SELECT id, NULL, ${titleWeight} * ts_rank_cd(search, q)
         FROM chats, query WHERE owner = $1 AND search @@ q),
       best AS (
         SELECT DISTINCT ON (chat_id) chat_id, message_id, rank
         FROM hits ORDER BY chat_id, rank DESC),
       top AS (
         SELECT b.chat_id, b.message_id, b.rank, c.title, c.updated_at
         FROM best b JOIN chats c ON c.owner = $1 AND c.id = b.chat_id
         ORDER BY b.rank DESC, c.updated_at DESC LIMIT ${searchHits})
       SELECT jsonb_build_object('hits', COALESCE(jsonb_agg(jsonb_build_object(
         'chatId', t.chat_id, 'messageId', t.message_id, 'title', t.title,
         'snippet', COALESCE(ts_headline('simple', left(m.text, ${indexedCharacters}), q,
           'MaxFragments=1, MinWords=6, MaxWords=18, StartSel="", StopSel=""'), ''))
         ORDER BY t.rank DESC, t.updated_at DESC), '[]'))::text AS data
       FROM top t CROSS JOIN query
       LEFT JOIN chat_messages m ON m.owner = $1 AND m.id = t.message_id`,
      [owner, terms],
    );
    return decodeJson(searchResponseSchema, result.rows[0].data);
  }
}

// Runs inside the terminal write because acknowledge later blanks the job's
// text and nulls the input this row is built from.
export async function storeReply(
  db: SqlConnection,
  owner: string,
  snapshot: AttemptSnapshot,
): Promise<void> {
  const seq = (await stamp(db, owner, 1)) + 1;
  await db.query(
    `INSERT INTO chat_messages (owner, id, seq, chat_id, parent_id, path_id,
       role, status, text, reasoning, picker, level, retry_model, actual_model,
       error, created_at)
     SELECT $1, j.attempt_id, $3, j.chat_id, (j.input->>'userTurnId')::uuid,
       j.path_id, 'assistant', $4, $5, $6, j.input->>'picker', j.input->>'level',
       j.input->>'retryModel', $7, $8, (extract(epoch FROM now()) * 1000)::bigint
     FROM chat_jobs j
     WHERE j.owner = $1 AND j.attempt_id = $2 AND j.input IS NOT NULL
       AND NOT ${tombstoned('j.chat_id')}
     ON CONFLICT (owner, id) DO NOTHING`,
    [
      owner,
      snapshot.attemptId,
      seq,
      snapshot.status,
      snapshot.text,
      snapshot.reasoning,
      snapshot.actualModel,
      snapshot.error,
    ],
  );
}

export async function purgeChat(
  db: SqlConnection,
  owner: string,
  chatId: string,
): Promise<void> {
  const seq = (await stamp(db, owner, 1)) + 1;
  await db.query(
    'UPDATE deleted_chats SET seq = $3 WHERE owner = $1 AND chat_id = $2 AND seq IS NULL',
    [owner, chatId, seq],
  );
  await db.query(
    'DELETE FROM chat_messages WHERE owner = $1 AND chat_id = $2',
    [owner, chatId],
  );
  await db.query('DELETE FROM chats WHERE owner = $1 AND id = $2', [
    owner,
    chatId,
  ]);
}
