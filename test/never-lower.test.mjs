// Tripwire for the never-lower invariant.
//
// On 2026-08-15 a replace=true upload rewrote every combined usage row to the
// machine's current local view, destroying ~27B tokens of historical peaks
// (local agent logs get pruned; server rows held the highs). v1.2.1 made the
// server always max-merge. This test scans the worker + CLI source so the
// lowering path can never be silently reintroduced by a refactor or partial
// revert. The assertions match how the code is actually shaped: the upsert
// interpolates a shared mergeValue() helper, so we pin that helper's
// construction AND its use for every numeric column.
//
// If this test fails, the change being merged can destroy user history.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const workerSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'),
  'utf8',
);

const NUMERIC_COLUMNS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'total_tokens',
  'cost_usd',
];

test('mergeValue is an unconditional MAX() template with no replace branch', () => {
  assert.match(
    workerSource,
    /const mergeValue = \(column: string\) => `MAX\(excluded\.\$\{column\}, daily_usage\.\$\{column\}\)`;/,
    'mergeValue must be exactly the unconditional MAX(excluded.col, daily_usage.col) template',
  );
  assert.ok(
    !workerSource.includes('body.replace === true'),
    'body.replace === true reintroduces the history-destroying path',
  );
  assert.ok(
    !workerSource.includes('replace === true'),
    'any replace === true branch in the worker can lower rows',
  );
  assert.ok(
    !workerSource.includes('mergeValue = (column: string) => body'),
    'mergeValue must not inspect the request body',
  );
});

test('every numeric upsert column goes through mergeValue', () => {
  for (const column of NUMERIC_COLUMNS) {
    assert.match(
      workerSource,
      new RegExp(`${column} = \\$\\{mergeValue\\('${column}'\\)\\}`),
      `${column} must be assigned via mergeValue('${column}')`,
    );
  }
});

test('no numeric column is ever blindly replaced by the upload handler', () => {
  for (const column of NUMERIC_COLUMNS) {
    assert.doesNotMatch(
      workerSource,
      new RegExp(`${column} = excluded\\.${column}(?!,)`),
      `${column} = excluded.${column} would let a client lower history`,
    );
  }
});

test('the CLI never has a replace flag to send (LDP contract)', () => {
  const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'ccrank-git');
  const cliSource = readdirSync(cliDir)
    .filter((name) => name.endsWith('.go'))
    .map((name) => readFileSync(join(cliDir, name), 'utf8'))
    .join('\n');
  // Case-insensitive + struct-tag aware: a typed `Replace bool` with a
  // `json:"replace"` tag must be caught too, not just map literals.
  assert.ok(
    !/["']replace["']\s*:/.test(cliSource),
    'CLI payload must not include a replace field — LDP never had one',
  );
  assert.ok(
    !/replace\s+bool/i.test(cliSource),
    'CLI must not accept a replace parameter',
  );
  assert.ok(
    !/json:\s*["']replace["']/.test(cliSource),
    'CLI structs must not serialize a replace field',
  );
});

// Shared DELETE tripwire matcher. Scoped to src/ ONLY:
// migrations/0012_unknown_date_cleanup.sql legitimately contains a one-time
// DELETE FROM daily_usage, so extending this matcher to migrations/*.sql
// as-is would false-positive on a sanctioned cleanup.
const DELETE_FROM_DAILY_USAGE = /DELETE\s+FROM\s+daily_usage/i;

function stripComments(content) {
  // Strip comments so documented one-time manual cleanup SQL does not trip
  // this tripwire; only live statements are matched.
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

// Recursive walk so a DELETE hiding in a future src/ subdirectory cannot
// dodge the tripwire that a flat readdirSync would miss.
function collectTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('no DELETE FROM daily_usage remains in worker source (totals may only go up)', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = collectTsFiles(srcDir);
  assert.ok(files.length > 0, 'expected TypeScript sources in src/');
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      stripComments(content),
      DELETE_FROM_DAILY_USAGE,
      `${relative(srcDir, file)} must not DELETE FROM daily_usage — totals may only ever go up`,
    );
  }
});

test('positive control: the DELETE matcher fires on a planted snippet', () => {
  assert.match(
    stripComments("await env.DB.prepare('DELETE FROM daily_usage WHERE date = ?').run()"),
    DELETE_FROM_DAILY_USAGE,
    'matcher must fire on a live DELETE FROM daily_usage statement',
  );
  assert.match(
    stripComments('delete  from\ndaily_usage'),
    DELETE_FROM_DAILY_USAGE,
    'matcher must fire regardless of case and whitespace',
  );
  assert.doesNotMatch(
    stripComments("// one-time manual cleanup:\n// DELETE FROM daily_usage WHERE date LIKE 'unknown-%';"),
    DELETE_FROM_DAILY_USAGE,
    'matcher must ignore DELETEs inside comments',
  );
});
