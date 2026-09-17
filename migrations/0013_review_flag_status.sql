-- Dismiss-queue drain: flags stay 'open' until an admin dismisses them.
-- Pre-migration rows backfill to 'open' via the column default, and queue
-- queries treat NULL status as open via COALESCE, so old rows keep showing.
ALTER TABLE review_flags ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
CREATE INDEX IF NOT EXISTS idx_review_flags_status ON review_flags(status);
