# Muse handover status — migrations/release (cla4, B4–B6) + anomaly evidence

Owner: cla4 executor. Scope: `migrations/`, `package.json` migration/test
wiring, `test/migrations.test.mjs`, this doc. No source-handler or CLI
changes. No PR merges, deploys, or production migrations performed.

Data invariant (never break): usage totals may only ever go UP. `/api/upload`
always max-merges every numeric column and ignores `replace`. Nothing here
lowers history.

## 1. B4 — migration safety (0010–0013)

Applied-state premise: PR #18 is unmerged, so 0011–0013 are unapplied in
prod. 0010 shipped on main via PR #11 (2026-08-15) and is treated as
applied/frozen: its content was not touched. Direct D1 confirmation was
blocked (see §7); ordering conclusions below rest on verified git + GitHub
evidence, and the rollout runbook (§5) re-verifies against prod before any
apply.

| Migration | Re-runnable | Lock / size risk | Verdict |
|---|---|---|---|
| 0010 audit triggers | Yes (`IF NOT EXISTS`) | DDL only; trigger adds one audit row per totals-changing UPDATE | Safe. One hole: `WHEN OLD.x != NEW.x` is NULL (no fire) on NULL↔value transitions — proven SQLite semantics (see §1.1). Content frozen (applied). |
| 0011 review_flags | Yes (`IF NOT EXISTS`) | New empty table + 2 indexes | Safe. |
| 0012 unknown-% cleanup | Yes (zero rows once clean) | Prefix `LIKE 'unknown-%'` uses the date index; single brief write txn | Safe pending blast-radius COUNT (§5 step 2). Cleanup is itself audited by 0010 (pinned by test). |
| 0013 status column | **No** — bare `ALTER TABLE` (SQLite has no `ADD COLUMN IF NOT EXISTS`); re-run errors `duplicate column name` | Table is tiny (created by 0011 in the same release) | Safe to apply once; re-run fails loud with zero data change (pinned by test). Matches repo convention (0003/0007/0008/0009 all use bare ALTER). |

### 1.1 Finding: 0010 misses NULL↔value transitions (mechanism proven, prod impact unknown)

`WHEN OLD.total_tokens != NEW.total_tokens ...` evaluates to NULL — trigger
does not fire — when either side is NULL. Proven locally: NULL→5 and 11→NULL
updates wrote no audit row while 10→11 did. A NULL-safe `WHEN` would need a
NEW migration rebuilding the triggers; that is NOT proposed now because no
evidence shows prod `daily_usage` numeric columns hold NULL (schema defaults
0, upload binds numbers). Verify-first SELECT is in §6.1; do not edit 0010
(it is applied — editing applied-migration content creates prod/repo drift).

### 1.2 Renumber decision: NO renumber — 0011/0012/0013 keep their numbers

- `origin/main` (367a0d1) contains migrations 0001–0010 only; PR #18's
  0011–0013 extend the sequence gaplessly.
- The rival `0011_user_slugs.sql` (b0307a0) exists ONLY on the local-only
  branch `chore/perf-health` (worktree `.wt/perf-health`): not on origin, not
  a PR (verified via `git ls-remote` + open-PR list). There is no collision
  on the merge path.
- Followup (for that branch's owner on rebase after PR #18 merges): renumber
  `0011_user_slugs.sql` → `0014_user_slugs.sql` and rewire its `db:migrate`
  chain. Recorded as a `bd create` draft in §8, not applied (out of scope).
- New migrations 0014/0015/0016 are NOT justified: nothing requires them.

## 2. B5 — PR #18 merge safety (verified live 2026-09-21)

`gh pr view 18 --repo makash/ccrank`: OPEN, MERGEABLE, mergeStateStatus
UNSTABLE. Head `fix/never-lower-anomaly-hardening @ e12f46f`, base
`main @ 367a0d1`. Five commits exactly as handed over
(b6ea5bc, e274349, 94a0081, d106177, e12f46f); remote head equals local —
no drift. Checks: `CLI tests` SUCCESS, `Worker tests + tripwire` SUCCESS,
`auto-merge` FAILURE (sole red). Base 367a0d1 is the revert of 3237a96 and
is an ancestor of the PR branch, so the diff has no ordering dependency on
the reverted commit. Squash-merge safe; merge only on the user's explicit
word (standing rule). cla4 did not touch PR #18 (auto-merge workflow would
fire on synchronize).

## 3. B6 + anomaly assist — Will Mitchell (read-only public evidence)

Source: `https://ccrank.dev/user/willmitchell` (+ `/api/leaderboard`),
fetched 2026-09-21. Identity: `share_slug` "willmitchell", display name
"Will Mitchell", rank #2, last active 2026-09-21.

Codex-confirmed aggregates (2026-09-21T13:03:50Z, independently reproduced
here): total_tokens 295092008210, total_output_tokens 1024912938,
total_cost 411575.37107289856 (estimated, highest $ on board), cache_rate
0.90077409651107, days_active 199. Platform split: Claude 244.9B/77d,
Pi 39.3B/107d, Codex 9.3B/75d, OpenCode 1.2B/15d, GLM 389.5M/4d, Grok
19.7M/7d.

### 3.1 Chronology (from heatmap daily cells: tokens + cost + row-count)

- Heatmap 365d sum ≈ 295.17B matches the API total (validates parsing).
- Step-change in August: Jan–Jul ≈ 45B combined (Jul dip 3.57B) → Aug
  138.91B ($197k) → Sep-to-date 110.98B ($181k). Aug+Sep ≈ 85% of lifetime.
- Five daily sums >10B (public rounded labels): Aug27 11.3B, Aug29 12.6B,
  Aug30 19.6B, Aug31 21.0B, Sep1 15.7B — ≈80.2B combined. Top cost days:
  Aug30 $34,705.90, Aug31 $34,638.23. Top-20 days ≈ 191B (65% of lifetime).
- Row-count ("sessions") per day never exceeds 4; several 4–9.6B days sit on
  a SINGLE row. Effective rates vary by day ($1.65/M on Aug31 → cache-heavy;
  ~$5/M on Sep15 → output-heavy), consistent with real mix shifts.

### 3.2 Control (#1, 348.5B): gradual ramp, comparable peaks

Same method: Jan 2.5B → Apr 21B → Jun 61B → Jul 86B → Aug 89B; top day
19.8B (Jul11) ≈ Will Mitchell's 21.0B peak; up to 9 rows/day. Top-3 cache
rates 90–96%: cache-read inflation dominates ALL top users, not one.

### 3.3 Proven vs hypotheses (no fraud inferred from high numbers)

Proven (public data): anomalous VOLUME and CONCENTRATION (85% in ~7 weeks
starting ~Aug17, right after the Aug15 replace incident); cross-key
duplication (same tokens under multiple source/platform rows) is ruled out
as the primary mechanism — ≤4 keys/day bounds it at ~4x, and single-row
multi-B days cannot be cross-key duplicates at all.
Hypotheses needing D1 (§6.2): within-row client double-count (importer
counting records twice — B1, other executors); two machines with
overlapping history under different `source` keys (≤4x bound); genuine
24/7 harness usage (output ≈ 5.1M/day over 199d is high but harness-
plausible; $/M mix shifts look organic); post-incident re-upload
ratcheting (chronology is suggestive, mechanism unclear under max-merge).
Public evidence is anomalous volume, NOT proof of duplicate records or
misconduct. No correction is justified on current evidence (§6 preamble).

## 4. Tests + commands added

- `test/migrations.test.mjs`: +7 tests (11 total). Static: 0012 pinned to
  the single scoped DELETE; migrations-dir never-lower tripwire (no other
  file may DELETE/UPDATE/DROP `daily_usage`). Behavioral (system `sqlite3`
  CLI via child_process — Node 20 safe, skips if binary absent): fresh
  full-chain apply; 0012 scope + audit-captured cleanup + no-op re-run;
  0011 re-run preserves rows; 0013 backfill/default + loud fail-safe
  re-run; 0010 pre-image/delete/no-op coverage.
- `package.json`: +`test:migrations` focused script. No `db:migrate:*`
  changes (chain already wires 0011–0013 in order).
- Results: `npm run test:migrations` 11/11; full `npm test` 111/111 (green
  baseline before changes was 104/104 after `npm ci`; the 8 pre-install
  failures were missing `node_modules`, environmental). Mutation probe:
  widened 0012 fails exactly the scope test; file restored (migrations/
  diff empty).

## 5. Safe rollout runbook (post-merge, authed shell)

Prereqs: PR #18 squash-merged; shell authed to the Cloudflare account that
owns D1 `claude-leaderboard-db` (database id `e222d37b-…-ff42`) with
`CLOUDFLARE_ACCOUNT_ID` set. NEVER from this cla4 worktree (unrelated
executor branches coexist).

1. Fresh logical export FIRST (before any apply):
   `npx wrangler d1 export claude-leaderboard-db --remote
   --output=/tmp/ccrank-pre-0011-0013-$(date +%F).sql` (or the documented
   backup path). Confirm file size/row counts.
2. Blast radius + pre-state (read-only, `--remote --command`):
   `SELECT COUNT(*), COALESCE(SUM(total_tokens),0) FROM daily_usage WHERE
   date LIKE 'unknown-%';`
   `SELECT name FROM sqlite_master WHERE name IN
   ('review_flags','daily_usage_audit','d1_migrations');`
   `SELECT COUNT(*) FROM daily_usage;`
   Proceed only if the unknown-% count/cost is reviewed and tiny; the
   cleanup is one-way (audit-logged, not loss-free).
3. Apply ONLY the three new files in order (never re-run the whole chain
   against prod — 0013's bare ALTER fails on re-run by design):
   `--file=migrations/0011_review_flags.sql`, then `0012`, then `0013`.
4. Verify: `SELECT COUNT(*) FROM review_flags;`
   `SELECT name FROM pragma_table_info('review_flags');` (expect `status`),
   `SELECT COUNT(*) FROM daily_usage WHERE date LIKE 'unknown-%';`
   (expect 0), `SELECT op, COUNT(*) FROM daily_usage_audit GROUP BY op;`
   (expect `delete` rows equal to step-2 count).
5. Rollback: no forward rollback exists for 0012 (deleted rows). Restore =
   re-import the step-1 export into a scratch DB and re-apply legitimate
   rows only — audited, never a client flag.

## 6. Export-first correction plan (historical rows)

No correction is currently scoped or justified: B6 evidence shows anomalous
volume, not proven-duplicate rows, and totals may only go up. If D1 ground
truth later PROVES specific rows are duplicates (same underlying records
counted twice), the audited path is:

1. Fresh export (as §5 step 1) + a second copy stored off-machine.
2. Correction as explicitly-approved admin D1 statements (deduped values
   computed from the export, reviewed in the open PR that carries them),
   applied once via the authed shell — never via `/api/upload` or a client
   flag; `replace` stays ignored.
3. Post-check: leaderboard/profile deltas equal exactly the approved
   amounts; audit rows confirm pre-images.
4. Record the incident + statements in `docs/handoffs/`.

### 6.1 Verify-first SELECTs (read-only; need account from §7)

```sql
-- Applied-state: which of 0010/0011/0013 (and rival slugs) are live?
SELECT name, type FROM sqlite_master
 WHERE name IN ('review_flags','daily_usage_audit','daily_usage_audit_update',
   'daily_usage_audit_delete','idx_users_slug') ORDER BY name;
SELECT name FROM pragma_table_info('review_flags');
SELECT name FROM pragma_table_info('users');
-- 0010 NULL-hole exposure: any NULL numerics in prod?
SELECT COUNT(*) FROM daily_usage WHERE total_tokens IS NULL
  OR cost_usd IS NULL OR input_tokens IS NULL OR output_tokens IS NULL
  OR cache_read_tokens IS NULL OR cache_creation_tokens IS NULL;
-- 0012 blast radius (also §5 step 2):
SELECT COUNT(*), COALESCE(SUM(total_tokens),0), COALESCE(SUM(cost_usd),0)
 FROM daily_usage WHERE date LIKE 'unknown-%';
```

### 6.2 Anomaly ground-truth SELECTs (Will Mitchell; aggregates only)

```sql
-- Identity (ids only; do not export emails/tokens):
SELECT id, display_name, share_slug FROM users WHERE share_slug='willmitchell';
-- Spike-day row split: one row or many? which source/platform keys?
-- (substitute :uid; repeat per spike date, e.g. 2026-08-30, 2026-08-31)
SELECT date, source, platform, input_tokens, output_tokens,
  cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, upload_id
 FROM daily_usage WHERE user_id=:uid AND date IN
 ('2026-08-27','2026-08-29','2026-08-30','2026-08-31','2026-09-01')
 ORDER BY date, total_tokens DESC;
-- Upload chronology around the ramp (frequency/size, no payload):
SELECT DATE(uploaded_at) d, COUNT(*), SUM(record_count)
 FROM uploads WHERE user_id=:uid AND uploaded_at >= '2026-08-01'
 GROUP BY d ORDER BY d;
-- Audit trail for the user (post-0010 mutations only):
SELECT changed_at, op, date, source, platform, total_tokens, cost_usd
 FROM daily_usage_audit WHERE user_id=:uid ORDER BY id;
```

## 7. Blocker: prod D1 account not reachable from here

Local wrangler OAuth (arbaz@serri.club) sees two accounts; `d1 list` shows
neither holds `claude-leaderboard-db` (acct `c98c9e33…` empty,
`cc245cad…` holds only `serri-cs`/`extempore`); `d1 info` on `e222d37b…`
returns 7404 not-found. No `CLOUDFLARE_*` API env vars exist. SSH `ldp`
(user arbaz, host lineupx-devbox…internal) works over BatchMode but its
wrangler auth fails (`Failed to fetch auth token: 400`). Need: a shell
authed to the owning account (likely the `akash@kloudle.com` Cloudflare
account) or its account id + token via the documented path. Until then:
no applied-migration confirmation, no per-row anomaly truth, no prod
apply. All B6 findings above are public-page evidence only.

## 8. Followups (drafted `bd` commands — NOT created: no `bd` binary here)

`.beads/issues.jsonl` deliberately untouched (shared data, no writer
conflicts risked, no ids invented). Run after review:

```bash
bd create "perf-health: renumber 0011_user_slugs to 0014 after PR18" \
  --description "chore/perf-health (local-only b0307a0) carries a rival migrations/0011_user_slugs.sql. After PR #18 merges with 0011_review_flags, rebase and renumber to 0014_user_slugs + rewire db:migrate chain. Evidence: docs/muse-handover-status.md §1.2" --priority 1 --type task
bd create "D1 verify-first: NULL numerics + unknown-% blast radius" \
  --description "Run docs/muse-handover-status.md §6.1 SELECTs from an authed shell before PR18 rollout. Gates 0012 blast radius and the 0010 NULL-hole exposure." --priority 1 --type task
bd create "Anomaly ground truth: Will Mitchell spike-day row split" \
  --description "Run §6.2 SELECTs (aggregates only, no PII export). Decides whether any audited correction is ever justified. Current status: volume proven anomalous, duplication unproven." --priority 2 --type task
```

## 9. Handover pointer

Full evidence log: `/tmp/ccrank-muse-cla4.md` (this worktree host only).
Commit on `flow/cla4-0921-1804` + test results are reported there. Next:
Codex review → user go/no-go on PR #18 squash-merge → §5 rollout.
