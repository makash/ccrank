-- Review-only anomaly queue: flags suspicious usage rows for admin review.
-- NEVER gates uploads: the upload path inserts here best-effort and always
-- returns success for valid reports.
CREATE TABLE IF NOT EXISTS review_flags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, date, reason)
);

CREATE INDEX IF NOT EXISTS idx_review_flags_user_date ON review_flags(user_id, date);
CREATE INDEX IF NOT EXISTS idx_review_flags_created ON review_flags(created_at);
