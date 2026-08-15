-- Audit trail for daily_usage: makes any future mutation of usage history
-- recoverable from the database itself.
--
-- On 2026-08-15 a replace=true upload lowered ~27B tokens of historical
-- peaks. Recovery depended on D1 Time Travel inside an account that was not
-- reachable at incident time. These triggers copy the pre-image of every
-- UPDATE (that changes totals) and every DELETE into daily_usage_audit, so a
-- future incident is a SELECT away from undo regardless of account access.
--
-- Updates only fire when totals actually change, so the monotonic upload
-- path (one UPDATE per higher day) costs one audit row per change.

CREATE TABLE IF NOT EXISTS daily_usage_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  op TEXT NOT NULL CHECK (op IN ('update', 'delete')),
  row_id TEXT,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  source TEXT,
  platform TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  models_used TEXT
);

CREATE TRIGGER IF NOT EXISTS daily_usage_audit_update
AFTER UPDATE ON daily_usage
WHEN OLD.total_tokens != NEW.total_tokens
  OR OLD.cost_usd != NEW.cost_usd
  OR OLD.input_tokens != NEW.input_tokens
  OR OLD.output_tokens != NEW.output_tokens
  OR OLD.cache_read_tokens != NEW.cache_read_tokens
  OR OLD.cache_creation_tokens != NEW.cache_creation_tokens
BEGIN
  INSERT INTO daily_usage_audit (
    op, row_id, user_id, date, source, platform,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
    total_tokens, cost_usd, models_used
  ) VALUES (
    'update', OLD.id, OLD.user_id, OLD.date, OLD.source, OLD.platform,
    OLD.input_tokens, OLD.output_tokens, OLD.cache_creation_tokens, OLD.cache_read_tokens,
    OLD.total_tokens, OLD.cost_usd, OLD.models_used
  );
END;

CREATE TRIGGER IF NOT EXISTS daily_usage_audit_delete
AFTER DELETE ON daily_usage
BEGIN
  INSERT INTO daily_usage_audit (
    op, row_id, user_id, date, source, platform,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
    total_tokens, cost_usd, models_used
  ) VALUES (
    'delete', OLD.id, OLD.user_id, OLD.date, OLD.source, OLD.platform,
    OLD.input_tokens, OLD.output_tokens, OLD.cache_creation_tokens, OLD.cache_read_tokens,
    OLD.total_tokens, OLD.cost_usd, OLD.models_used
  );
END;
