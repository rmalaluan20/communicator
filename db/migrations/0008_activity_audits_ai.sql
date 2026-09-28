-- Additive history for real activity and AI audits.
-- Does not modify app_state, notes, messages, or any existing rows.

CREATE TABLE IF NOT EXISTS activity_log (
  id            BIGSERIAL PRIMARY KEY,
  subaccount_id TEXT,
  activity_type TEXT NOT NULL,
  actor_type    TEXT NOT NULL DEFAULT 'user',
  actor_id      TEXT,
  actor_name    TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_log_sub_idx ON activity_log (subaccount_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log (created_at DESC);

CREATE TABLE IF NOT EXISTS audits (
  id             BIGSERIAL PRIMARY KEY,
  subaccount_id  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  auditor        TEXT NOT NULL DEFAULT 'AI Agent',
  overall        TEXT NOT NULL,
  completion     INTEGER NOT NULL,
  verified       INTEGER NOT NULL DEFAULT 0,
  incomplete     INTEGER NOT NULL DEFAULT 0,
  blocked        INTEGER NOT NULL DEFAULT 0,
  needs_review   INTEGER NOT NULL DEFAULT 0,
  unable         INTEGER NOT NULL DEFAULT 0,
  summary        TEXT NOT NULL DEFAULT '',
  result         JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS audits_sub_idx ON audits (subaccount_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_settings (
  id               INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider         TEXT NOT NULL DEFAULT 'openai',
  model            TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  enabled          BOOLEAN NOT NULL DEFAULT false,
  api_key          TEXT,
  apply_checklist  BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO ai_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Timestamp-only signal so browsers can refetch through the existing
-- authenticated APIs. The row never contains workspace data.
CREATE TABLE IF NOT EXISTS sync_signal (
  id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO sync_signal (id, updated_at) VALUES (1, now()) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION fos_touch_sync() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO sync_signal (id, updated_at) VALUES (1, now())
  ON CONFLICT (id) DO UPDATE SET updated_at = now();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS app_state_sync ON app_state;
CREATE TRIGGER app_state_sync
  AFTER INSERT OR UPDATE ON app_state
  FOR EACH ROW EXECUTE FUNCTION fos_touch_sync();

DROP TRIGGER IF EXISTS notes_sync ON notes;
CREATE TRIGGER notes_sync
  AFTER INSERT OR UPDATE OR DELETE ON notes
  FOR EACH ROW EXECUTE FUNCTION fos_touch_sync();

DROP TRIGGER IF EXISTS messages_sync ON messages;
CREATE TRIGGER messages_sync
  AFTER INSERT OR UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION fos_touch_sync();

DROP TRIGGER IF EXISTS activity_log_sync ON activity_log;
CREATE TRIGGER activity_log_sync
  AFTER INSERT ON activity_log
  FOR EACH ROW EXECUTE FUNCTION fos_touch_sync();

DROP TRIGGER IF EXISTS audits_sync ON audits;
CREATE TRIGGER audits_sync
  AFTER INSERT ON audits
  FOR EACH ROW EXECUTE FUNCTION fos_touch_sync();

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_signal ENABLE ROW LEVEL SECURITY;

-- No policies for activity, audits, or AI settings: the app connects as the
-- table owner. The browser Data API cannot read secrets or history.
DROP POLICY IF EXISTS sync_signal_read ON sync_signal;
CREATE POLICY sync_signal_read ON sync_signal
  FOR SELECT TO anon, authenticated
  USING (true);
