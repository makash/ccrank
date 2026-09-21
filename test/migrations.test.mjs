// Guards against the 0010 story: migrations/0010_daily_usage_audit.sql existed
// in the repo but was not referenced by the db:migrate scripts, so it never
// applied to D1. This is a pure static check over repo files (fs/path only,
// no D1): every migration on disk must be wired into a db:* script, and the
// sequence must have no duplicates or gaps.
//
// If this test fails, a migration file exists that `npm run db:migrate`
// will never apply.

import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'migrations');

const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const scriptKeys = Object.keys(pkg.scripts ?? {});
const migrateKeys = scriptKeys.filter(
  (k) => k === 'db:migrate' || k.startsWith('db:migrate:'),
);
const seedKeys = scriptKeys.filter(
  (k) => k === 'db:seed' || k.startsWith('db:seed:'),
);

// Extract every --file=migrations/NNNN_*.sql reference from the given
// package.json scripts, splitting chained `&&` commands so each wrangler
// invocation is covered. Returns a Map of script key -> referenced files.
function referencedMigrations(keys) {
  const refs = new Map();
  for (const key of keys) {
    const script = pkg.scripts[key];
    assert.ok(
      typeof script === 'string' && script.length > 0,
      `package.json must define a non-empty scripts["${key}"]`,
    );
    const files = [];
    for (const segment of script.split('&&')) {
      const match = segment.match(/--file=(migrations\/\d{4}_[\w-]+\.sql)/);
      if (match) files.push(match[1].split('/')[1]);
    }
    refs.set(key, files);
  }
  return refs;
}

test('migration filenames are NNNN_name.sql with no duplicate numbers and no gaps from 0001', () => {
  assert.ok(
    migrationFiles.length > 0,
    'migrations/ must contain at least one .sql file',
  );
  const numbers = [];
  for (const file of migrationFiles) {
    const match = file.match(/^(\d{4})_[a-z0-9_]+\.sql$/);
    assert.ok(match, `${file} must match NNNN_name.sql (lowercase)`);
    numbers.push(Number(match[1]));
  }
  assert.deepStrictEqual(
    [...numbers].sort((a, b) => a - b),
    [...new Set(numbers)].sort((a, b) => a - b),
    'migration numbers must not repeat',
  );
  const sorted = [...numbers].sort((a, b) => a - b);
  sorted.forEach((n, i) => {
    assert.equal(
      n,
      i + 1,
      `gap in migration sequence: position ${i} holds ${String(n).padStart(4, '0')}, expected ${String(i + 1).padStart(4, '0')}`,
    );
  });
});

test('every migration file is referenced by the db:migrate / db:seed scripts', () => {
  assert.ok(migrateKeys.length > 0, 'package.json must define db:migrate scripts');
  assert.ok(seedKeys.length > 0, 'package.json must define db:seed scripts');
  const migrateRefs = referencedMigrations(migrateKeys);
  const seedRefs = referencedMigrations(seedKeys);
  // Seed data (0002) ships via db:seed, schema via db:migrate; every file on
  // disk must be reachable through at least one of them.
  const wired = new Set(
    [...migrateRefs.values(), ...seedRefs.values()].flatMap((s) => [...s]),
  );
  for (const file of migrationFiles) {
    assert.ok(
      wired.has(file),
      `${file} exists in migrations/ but is not referenced by any db:migrate/db:seed script — it would never apply`,
    );
  }
  // Order is load-bearing (0009's UNIQUE INDEX needs 0003's source
  // column), so assert per-chain numeric order plus order-identical twins —
  // set-equality alone would pass a swapped chain that breaks fresh DBs.
  for (const refs of [migrateRefs, seedRefs]) {
    for (const [key, files] of refs) {
      const numbers = files.map((f) => Number(f.slice(0, 4)));
      assert.deepStrictEqual(
        [...numbers].sort((a, b) => a - b),
        numbers,
        `scripts["${key}"] must apply migrations in numeric order`,
      );
    }
    const [first, ...rest] = [...refs.values()];
    for (const other of rest) {
      assert.deepStrictEqual(
        other,
        first,
        'db script :local variant applies a different migration ORDER than its remote twin',
      );
    }
  }
});

test('0010_daily_usage_audit.sql exists and is wired into db:migrate', () => {
  assert.ok(
    migrationFiles.includes('0010_daily_usage_audit.sql'),
    'migrations/0010_daily_usage_audit.sql must exist',
  );
  const migrateRefs = referencedMigrations(migrateKeys);
  for (const [key, files] of migrateRefs) {
    assert.ok(
      files.includes('0010_daily_usage_audit.sql'),
      `0010_daily_usage_audit.sql must be referenced by scripts["${key}"]`,
    );
  }
});

test('every referenced migration file exists on disk with no repeats per chain', () => {
  // Reverse direction of the wiring test above: a --file= reference to a
  // missing migration breaks the chain, and a repeated reference would
  // apply one migration twice on fresh DBs.
  const onDisk = new Set(migrationFiles);
  const allRefs = referencedMigrations([...migrateKeys, ...seedKeys]);
  for (const [key, files] of allRefs) {
    for (const file of files) {
      assert.ok(
        onDisk.has(file),
        `scripts["${key}"] references ${file} but it does not exist in migrations/`,
      );
    }
    assert.deepStrictEqual(
      [...new Set(files)],
      files,
      `scripts["${key}"] references a migration more than once`,
    );
  }
});

// ---------------------------------------------------------------------------
// Migration safety: idempotency + data preservation (B4).
//
// The static wiring tests above prove every file is referenced; the tests
// below prove what the files DO is safe to apply to prod D1: the 0012
// cleanup is scoped (never-lower), re-runnable steps stay re-runnable, the
// one non-idempotent step (0013's bare ALTER TABLE) fails safe without data
// change, and the 0010 audit trail records the cleanup itself so it stays
// recoverable.
//
// Behavioral tests drive the system `sqlite3` CLI (same engine family as
// D1) via child_process so they run on Node 20 CI, which has no
// node:sqlite. They skip when the binary is absent; the static guards in
// this section always run.
// ---------------------------------------------------------------------------

function stripSqlLineComments(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();
}

test('0012 cleanup is a single DELETE scoped to unknown-% dates only', () => {
  const body = stripSqlLineComments(
    readFileSync(join(migrationsDir, '0012_unknown_date_cleanup.sql'), 'utf8'),
  );
  assert.match(
    body,
    /^DELETE\s+FROM\s+daily_usage\s+WHERE\s+date\s+LIKE\s+'unknown-%';?\s*$/i,
    '0012 must contain exactly one statement: DELETE FROM daily_usage WHERE date LIKE \'unknown-%\'',
  );
});

test('no migration outside 0012 deletes from or updates daily_usage', () => {
  // Migrations-dir twin of the never-lower tripwire (which covers src/
  // only): totals may only go up, so no migration may rewrite or drop
  // usage rows except the sanctioned 0012 malformed-date cleanup.
  for (const file of migrationFiles) {
    const body = stripSqlLineComments(
      readFileSync(join(migrationsDir, file), 'utf8'),
    );
    if (file !== '0012_unknown_date_cleanup.sql') {
      assert.doesNotMatch(
        body,
        /DELETE\s+FROM\s+daily_usage/i,
        `${file} must not DELETE FROM daily_usage — only the sanctioned 0012 cleanup may`,
      );
    }
    assert.doesNotMatch(
      body,
      /UPDATE\s+(OR\s+\w+\s+)?daily_usage/i,
      `${file} must not UPDATE daily_usage — migrations never rewrite usage rows`,
    );
    assert.doesNotMatch(
      body,
      /DROP\s+TABLE\s+(IF\s+EXISTS\s+)?daily_usage/i,
      `${file} must not DROP daily_usage`,
    );
  }
});

let sqlite3Status = null;
function sqlite3Available() {
  if (sqlite3Status === null) {
    const probe = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' });
    sqlite3Status = probe.status === 0;
  }
  return sqlite3Status;
}

function skipWithoutSqlite3(t) {
  if (!sqlite3Available()) {
    t.skip('sqlite3 CLI not available on PATH');
    return true;
  }
  return false;
}

function freshDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ccrank-mig-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'test.db');
}

function runSql(dbPath, sql, args = []) {
  return spawnSync('sqlite3', [...args, dbPath], {
    input: sql,
    encoding: 'utf8',
  });
}

function applyMigration(dbPath, file) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  const result = runSql(dbPath, sql);
  assert.equal(
    result.status,
    0,
    `${file} failed to apply: ${(result.stderr || '').trim()}`,
  );
  return result;
}

function queryJson(dbPath, sql) {
  const result = runSql(dbPath, sql, ['-json']);
  assert.equal(result.status, 0, `query failed: ${(result.stderr || '').trim()}`);
  const out = (result.stdout || '').trim();
  return out === '' ? [] : JSON.parse(out);
}

// db:migrate order (schema) + db:seed (0002), mirroring package.json.
const FRESH_CHAIN = [
  '0001_initial.sql',
  '0002_seed_invites.sql',
  '0003_add_source.sql',
  '0004_drop_old_index.sql',
  '0005_add_sharing.sql',
  '0006_add_fav_tools.sql',
  '0007_add_git_metadata.sql',
  '0008_add_git_machine.sql',
  '0009_add_platform.sql',
  '0010_daily_usage_audit.sql',
  '0011_review_flags.sql',
  '0012_unknown_date_cleanup.sql',
  '0013_review_flag_status.sql',
];

function seedUserAndUsage(dbPath) {
  runSql(
    dbPath,
    `INSERT INTO users (id, google_id, email, display_name) VALUES ('u1', 'g1', 'u1@example.com', 'Test User');`,
  );
}

test('full chain 0001..0013 applies cleanly to a fresh database', (t) => {
  if (skipWithoutSqlite3(t)) return;
  const db = freshDb(t);
  for (const file of FRESH_CHAIN) applyMigration(db, file);
  const tables = queryJson(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
  ).map((r) => r.name);
  for (const expected of ['daily_usage', 'daily_usage_audit', 'review_flags']) {
    assert.ok(tables.includes(expected), `fresh chain must create ${expected}`);
  }
  const flagCols = queryJson(db, 'SELECT name FROM pragma_table_info(\'review_flags\');').map(
    (r) => r.name,
  );
  assert.ok(flagCols.includes('status'), 'fresh chain must end with review_flags.status');
  const triggers = queryJson(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name;",
  ).map((r) => r.name);
  assert.ok(
    triggers.includes('daily_usage_audit_update') && triggers.includes('daily_usage_audit_delete'),
    'fresh chain must create the 0010 audit triggers',
  );
});

test('0012 removes only unknown-% rows and the audit trail records the cleanup', (t) => {
  if (skipWithoutSqlite3(t)) return;
  const db = freshDb(t);
  for (const file of FRESH_CHAIN.slice(0, 11)) applyMigration(db, file); // stop after 0011
  seedUserAndUsage(db);
  runSql(
    db,
    `INSERT INTO daily_usage (id, upload_id, user_id, date, source, platform, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, models_used) VALUES
     ('r-normal', 'up1', 'u1', '2026-01-01', 'mac', 'claude', 100, 50, 10, 1000, 1160, 1.5, '["opus"]'),
     ('r-legacy', 'up1', 'u1', 'unknown-2024-01', 'mac', 'claude', 7, 8, 0, 0, 15, 0.02, '[]'),
     ('r-exact', 'up1', 'u1', 'unknown', 'mac', 'claude', 3, 4, 0, 0, 7, 0.01, '[]');`,
  );
  const before = queryJson(db, 'SELECT * FROM daily_usage ORDER BY id;');
  assert.equal(before.length, 3, 'seed must hold 3 rows before 0012');
  applyMigration(db, '0012_unknown_date_cleanup.sql');
  const after = queryJson(db, 'SELECT * FROM daily_usage ORDER BY id;');
  assert.deepStrictEqual(
    after,
    before.filter((r) => r.id !== 'r-legacy'),
    '0012 must delete exactly the unknown-% row and leave every other row byte-identical',
  );
  const audit = queryJson(
    db,
    "SELECT op, date, total_tokens FROM daily_usage_audit WHERE op = 'delete' ORDER BY date;",
  );
  assert.deepStrictEqual(
    audit,
    [{ op: 'delete', date: 'unknown-2024-01', total_tokens: 15 }],
    '0010 audit trigger must record the 0012 cleanup so it stays recoverable',
  );
  // Re-runnable: second application matches zero rows and changes nothing.
  applyMigration(db, '0012_unknown_date_cleanup.sql');
  assert.deepStrictEqual(
    queryJson(db, 'SELECT * FROM daily_usage ORDER BY id;'),
    after,
    're-running 0012 must be a no-op',
  );
});

test('0011 review_flags is re-runnable and preserves existing flag rows', (t) => {
  if (skipWithoutSqlite3(t)) return;
  const db = freshDb(t);
  for (const file of FRESH_CHAIN.slice(0, 11)) applyMigration(db, file); // stop after 0011
  seedUserAndUsage(db);
  runSql(
    db,
    `INSERT INTO review_flags (id, user_id, date, reason, detail) VALUES ('f1', 'u1', '2026-08-30', 'volume_spike', '{"tokens": 1}');`,
  );
  const before = queryJson(db, 'SELECT * FROM review_flags ORDER BY id;');
  applyMigration(db, '0011_review_flags.sql');
  assert.deepStrictEqual(
    queryJson(db, 'SELECT * FROM review_flags ORDER BY id;'),
    before,
    're-applying 0011 must preserve existing flag rows',
  );
});

test('0013 backfills open, defaults new rows, and re-run fails without data change', (t) => {
  if (skipWithoutSqlite3(t)) return;
  const db = freshDb(t);
  for (const file of FRESH_CHAIN.slice(0, 11)) applyMigration(db, file); // stop after 0011
  seedUserAndUsage(db);
  runSql(
    db,
    `INSERT INTO review_flags (id, user_id, date, reason) VALUES ('f-old', 'u1', '2026-08-30', 'volume_spike');`,
  );
  applyMigration(db, '0013_review_flag_status.sql');
  assert.deepStrictEqual(
    queryJson(db, "SELECT id, status FROM review_flags WHERE id = 'f-old';"),
    [{ id: 'f-old', status: 'open' }],
    '0013 must backfill pre-migration flag rows to open',
  );
  runSql(
    db,
    `INSERT INTO review_flags (id, user_id, date, reason) VALUES ('f-new', 'u1', '2026-08-31', 'cost_implausible');`,
  );
  assert.deepStrictEqual(
    queryJson(db, "SELECT id, status FROM review_flags WHERE id = 'f-new';"),
    [{ id: 'f-new', status: 'open' }],
    'new flag rows must default to open after 0013',
  );
  // 0013 is the one non-idempotent step (SQLite has no ADD COLUMN IF NOT
  // EXISTS): a re-run must fail LOUDLY on the duplicate column while
  // leaving every row untouched — never half-apply.
  const snapshot = queryJson(db, 'SELECT * FROM review_flags ORDER BY id;');
  const rerun = runSql(db, readFileSync(join(migrationsDir, '0013_review_flag_status.sql'), 'utf8'));
  assert.notEqual(rerun.status, 0, 're-running 0013 must fail (duplicate column), surfacing the re-run instead of silently double-applying');
  assert.match(
    (rerun.stderr || '').toLowerCase(),
    /duplicate column/,
    '0013 re-run failure must name the duplicate column',
  );
  assert.deepStrictEqual(
    queryJson(db, 'SELECT * FROM review_flags ORDER BY id;'),
    snapshot,
    'failed 0013 re-run must leave flag rows untouched',
  );
});

test('0010 audit captures update pre-images and deletes, skips no-op updates', (t) => {
  if (skipWithoutSqlite3(t)) return;
  const db = freshDb(t);
  for (const file of FRESH_CHAIN.slice(0, 10)) applyMigration(db, file); // stop after 0010
  seedUserAndUsage(db);
  runSql(
    db,
    `INSERT INTO daily_usage (id, upload_id, user_id, date, source, platform, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, models_used)
     VALUES ('r1', 'up1', 'u1', '2026-01-01', 'mac', 'claude', 100, 50, 10, 1000, 1160, 1.5, '[]');`,
  );
  runSql(db, `UPDATE daily_usage SET total_tokens = 2000, cost_usd = 2.5 WHERE id = 'r1';`);
  assert.deepStrictEqual(
    queryJson(db, 'SELECT op, date, total_tokens, cost_usd FROM daily_usage_audit ORDER BY id;'),
    [{ op: 'update', date: '2026-01-01', total_tokens: 1160, cost_usd: 1.5 }],
    'audit must store the pre-image of a totals-changing UPDATE',
  );
  runSql(db, `UPDATE daily_usage SET models_used = '["opus"]' WHERE id = 'r1';`);
  assert.equal(
    queryJson(db, 'SELECT COUNT(*) AS n FROM daily_usage_audit;')[0].n,
    1,
    'audit must skip updates that do not change totals',
  );
  runSql(db, `DELETE FROM daily_usage WHERE id = 'r1';`);
  assert.deepStrictEqual(
    queryJson(db, 'SELECT op, date, total_tokens FROM daily_usage_audit ORDER BY id;'),
    [
      { op: 'update', date: '2026-01-01', total_tokens: 1160 },
      { op: 'delete', date: '2026-01-01', total_tokens: 2000 },
    ],
    'audit must record deletes with the removed totals',
  );
});
