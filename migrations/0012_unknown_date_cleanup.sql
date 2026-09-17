-- One-time cleanup for legacy 'unknown-%' rows emitted by old parser
-- versions when ccusage renamed date -> period. Idempotent and safe to
-- re-run (matches zero rows once clean). The per-upload DELETE this
-- replaces was removed: uploads must never destroy history.
DELETE FROM daily_usage WHERE date LIKE 'unknown-%';
