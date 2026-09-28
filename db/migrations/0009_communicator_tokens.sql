-- Per-subaccount Communicator tokens. Not part of the workspace blob,
-- so a full-state save cannot copy them into the browser.

CREATE TABLE IF NOT EXISTS communicator_tokens (
  subaccount_id TEXT PRIMARY KEY,
  api_key       TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE communicator_tokens ENABLE ROW LEVEL SECURITY;
