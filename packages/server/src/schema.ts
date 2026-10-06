export const schemaSql = `
CREATE TABLE IF NOT EXISTS chat_jobs (
  owner text NOT NULL,
  attempt_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  path_id uuid NOT NULL,
  request_hash text NOT NULL,
  input jsonb,
  state jsonb NOT NULL,
  checkpoint jsonb,
  PRIMARY KEY (owner, attempt_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_jobs_active_path
  ON chat_jobs (owner, chat_id, path_id)
  WHERE state->'snapshot'->>'status' IN
    ('accepted', 'selecting', 'compacting', 'generating');
CREATE TABLE IF NOT EXISTS chat_job_events (
  owner text NOT NULL,
  attempt_id uuid NOT NULL,
  sequence bigint NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY (owner, attempt_id, sequence),
  FOREIGN KEY (owner, attempt_id)
    REFERENCES chat_jobs (owner, attempt_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS deleted_chats (
  owner text NOT NULL,
  chat_id uuid NOT NULL,
  PRIMARY KEY (owner, chat_id)
);
CREATE TABLE IF NOT EXISTS cancelled_attempts (
  owner text NOT NULL,
  attempt_id uuid NOT NULL,
  PRIMARY KEY (owner, attempt_id)
);
CREATE TABLE IF NOT EXISTS chat_input_parts (
  owner text NOT NULL,
  attempt_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  part_index integer NOT NULL,
  parts integer NOT NULL,
  characters bigint NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, attempt_id, part_index)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sign_in_nonces (
  nonce_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_owners (
  owner text PRIMARY KEY,
  seq bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  owner text NOT NULL,
  id uuid NOT NULL,
  seq bigint NOT NULL,
  title text NOT NULL,
  picker text NOT NULL,
  level text,
  base_path_id uuid NOT NULL,
  leaf_id uuid NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS chats_seq ON chats (owner, seq);
CREATE TABLE IF NOT EXISTS chat_messages (
  owner text NOT NULL,
  id uuid NOT NULL,
  seq bigint NOT NULL,
  chat_id uuid NOT NULL,
  parent_id uuid,
  path_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  status text NOT NULL
    CHECK (status IN ('completed', 'stopped', 'interrupted', 'failed')),
  text text NOT NULL,
  reasoning text NOT NULL,
  image_count smallint NOT NULL DEFAULT 0,
  picker text NOT NULL,
  level text,
  retry_model text,
  actual_model text,
  error text,
  created_at bigint NOT NULL,
  PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS chat_messages_seq ON chat_messages (owner, seq);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages (owner, chat_id);
ALTER TABLE deleted_chats ADD COLUMN IF NOT EXISTS seq bigint;
CREATE INDEX IF NOT EXISTS deleted_chats_seq ON deleted_chats (owner, seq);
ALTER TABLE chats ADD COLUMN IF NOT EXISTS search tsvector
  GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, title)) STORED;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS search tsvector
  GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, left(text, 100000))) STORED;
CREATE INDEX IF NOT EXISTS chats_search ON chats USING gin (search);
CREATE INDEX IF NOT EXISTS chat_messages_search ON chat_messages USING gin (search);
`;
