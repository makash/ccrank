// Guards against the 0010 story: migrations/0010_daily_usage_audit.sql existed
// in the repo but was not referenced by the db:migrate scripts, so it never
// applied to D1. This is a pure static check over repo files (fs/path only,
// no D1): every migration on disk must be wired into a db:* script, and the
// sequence must have no duplicates or gaps.
//
// If this test fails, a migration file exists that `npm run db:migrate`
// will never apply.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
