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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
  const cliSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'ccrank-git', 'main.go'),
    'utf8',
  );
  assert.ok(
    !/"replace"\s*:/.test(cliSource),
    'CLI payload must not include a replace field — LDP never had one',
  );
  assert.ok(
    !/replace\s+bool/.test(cliSource),
    'CLI must not accept a replace parameter',
  );
});
