CREATE TABLE IF NOT EXISTS chat_agent_sessions (
  chat_id uuid PRIMARY KEY,
  messages jsonb NOT NULL,
  pending_tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
  step_count integer NOT NULL DEFAULT 0,
  run_token_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (
    status IN ('running', 'ready', 'awaiting_approval', 'failed')
  ),
  user_id text REFERENCES "user"(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chat_agent_sessions
  ADD COLUMN IF NOT EXISTS run_token_count integer NOT NULL DEFAULT 0;

ALTER TABLE chat_agent_sessions
  ADD COLUMN IF NOT EXISTS user_id text REFERENCES "user"(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS chat_agent_sessions_user_id_idx
  ON chat_agent_sessions (user_id);
