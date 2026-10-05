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
`;
