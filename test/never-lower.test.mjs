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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

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
    // No trailing-comma lookahead: real upsert lines end with a comma
    // (`total_tokens = excluded.total_tokens,`), so `(?!,)` false-negatived
    // on exactly the lowering SQL this pins against (proven by mutation).
    // The `= excluded.` literal still keeps the MAX(excluded.col, ...)
    // template out; the boundary only guards longer column names.
    assert.doesNotMatch(
      workerSource,
      new RegExp(`${column} = excluded\\.${column}\\b`),
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

// ─── B3 behavioral proof ─────────────────────────────────────────────────────
// The tripwires above pin the upsert SQL text. These tests execute the real
// /api/upload handler and apply the upsert with SQL-driven merge semantics:
// each numeric column max-merges IFF the bound statement's SQL text contains
// the MAX(excluded.col, daily_usage.col) template for that column, and plain
// REPLACES otherwise (exactly what D1 would do with such SQL). A refactor
// that drops MAX for any column therefore fails behaviorally here, not just
// textually above. Follows the existing stateful-mock approach (no new
// runtime deps; runs on the CI Node 20).

const b3BundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-never-lower-'));
let b3App;

before(async () => {
  const outdir = path.join(b3BundleDir, 'app');
  await build({
    entryPoints: ['src/index.ts'],
    outdir,
    bundle: true,
    entryNames: 'bundle',
    format: 'esm',
    loader: { '.wasm': 'file' },
    platform: 'node',
    logLevel: 'silent',
  });
  b3App = await import(pathToFileURL(path.join(outdir, 'bundle.js')).href);
});

after(async () => {
  await rm(b3BundleDir, { recursive: true, force: true });
});

const b3User = {
  id: 'user-1',
  google_id: 'google-1',
  email: 'neverlower@example.com',
  display_name: 'Never Lower',
  avatar_url: null,
  is_admin: 0,
  invites_remaining: 0,
  sharing_enabled: 1,
  git_sharing_enabled: 1,
  share_slug: 'never-lower',
  fav_tools: '[]',
};

// Binding positions in the daily_usage upsert VALUES list:
// id, upload_id, user_id, date, source, platform, input, output,
// cache_creation, cache_read, total, cost, models.
const B3_BIND_POS = {
  input_tokens: 6,
  output_tokens: 7,
  cache_creation_tokens: 8,
  cache_read_tokens: 9,
  total_tokens: 10,
  cost_usd: 11,
};

function createNeverLowerDatabase() {
  // Keyed like the UNIQUE(user_id, date, source, platform) conflict target.
  const usage = new Map();
  const db = {
    prepare(sql) {
      const exec = {
        async first() {
          if (/FROM api_tokens/.test(sql)) return { id: 'token-1', user_id: b3User.id };
          if (/FROM users/.test(sql)) return b3User;
          return null;
        },
        async all() {
          if (/ORDER BY total_tokens/.test(sql)) {
            const rows = [...usage.values()]
              .filter((row) => row.total_tokens > 0)
              .sort((a, b) => a.total_tokens - b.total_tokens)
              .map((row) => ({ date: row.date, total_tokens: row.total_tokens }));
            return { results: rows };
          }
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
      };
      const statement = {
        sql,
        bindings: [],
        ...exec,
        bind(...bindings) {
          return { sql, bindings, ...exec };
        },
      };
      return statement;
    },
    async batch(batch) {
      for (const stmt of batch) {
        if (/INSERT INTO daily_usage/.test(stmt.sql)) {
          const b = stmt.bindings;
          const key = [b[2], b[3], b[4], b[5]].join('|');
          const prev = usage.get(key) || {
            user_id: b[2],
            date: b[3],
            source: b[4],
            platform: b[5],
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 0,
            cost_usd: 0,
          };
          const next = { ...prev };
          for (const column of NUMERIC_COLUMNS) {
            const incoming = Number(b[B3_BIND_POS[column]]) || 0;
            if (stmt.sql.includes(`MAX(excluded.${column}, daily_usage.${column})`)) {
              next[column] = Math.max(prev[column], incoming);
            } else {
              next[column] = incoming;
            }
          }
          usage.set(key, next);
        }
      }
      return batch.map(() => ({ success: true }));
    },
  };
  return { db, usage };
}

function b3Report(rows) {
  return JSON.stringify({
    type: 'daily',
    daily: rows.map((r) => ({
      date: r.date ?? '2026-09-10',
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      cacheReadTokens: r.cacheReadTokens,
      totalTokens: r.totalTokens,
      totalCost: r.totalCost,
      modelsUsed: ['claude-sonnet-4-5'],
    })),
  });
}

async function b3Upload(db, rows, extraBody = {}) {
  return b3App.default.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer [REDACTED]', 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: b3Report(rows), source: 'secrig', ...extraBody }),
    },
    { DB: db }
  );
}

const B3_HIGH = {
  inputTokens: 100000,
  outputTokens: 20000,
  cacheCreationTokens: 5000,
  cacheReadTokens: 30000,
  totalTokens: 155000,
  totalCost: 12.5,
};

const B3_LOW = {
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationTokens: 10,
  cacheReadTokens: 300,
  totalTokens: 430,
  totalCost: 0.01,
};

function b3Stored(usage) {
  const row = usage.get('user-1|2026-09-10|secrig|claude');
  assert.ok(row, 'expected the uploaded row in the usage store');
  return row;
}

test('B3: lower-valued duplicate uploads cannot decrease any numeric column', async () => {
  const { db, usage } = createNeverLowerDatabase();

  const first = await b3Upload(db, [B3_HIGH]);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).ok, true);
  const duplicate = await b3Upload(db, [B3_HIGH]);
  assert.equal(duplicate.status, 200);
  const lower = await b3Upload(db, [B3_LOW]);
  assert.equal(lower.status, 200);
  assert.equal((await lower.json()).ok, true);

  const row = b3Stored(usage);
  assert.equal(row.input_tokens, 100000);
  assert.equal(row.output_tokens, 20000);
  assert.equal(row.cache_creation_tokens, 5000);
  assert.equal(row.cache_read_tokens, 30000);
  assert.equal(row.total_tokens, 155000);
  assert.equal(row.cost_usd, 12.5);
});

test('B3: replace:true in the upload body is ignored (peaks hold)', async () => {
  // The 2026-08-15 incident shape: a client sends replace:true with a lower
  // local view. The server must not read the flag at all.
  assert.ok(
    !workerSource.includes('body.replace'),
    'the worker must never read body.replace — the flag is ignored, not honored',
  );
  const { db, usage } = createNeverLowerDatabase();

  assert.equal((await (await b3Upload(db, [B3_HIGH])).json()).ok, true);
  const res = await b3Upload(db, [B3_LOW], { replace: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  const row = b3Stored(usage);
  for (const column of NUMERIC_COLUMNS) {
    const expected = {
      input_tokens: 100000,
      output_tokens: 20000,
      cache_creation_tokens: 5000,
      cache_read_tokens: 30000,
      total_tokens: 155000,
      cost_usd: 12.5,
    }[column];
    assert.equal(row[column], expected, `${column} decreased under replace:true`);
  }
});

test('B3: per-column max — higher fields move up while lower fields hold', async () => {
  // Max-merge is per column, not a row freeze: a second upload that raises
  // output/cost but lowers everything else moves exactly those two up.
  const { db, usage } = createNeverLowerDatabase();

  assert.equal((await (await b3Upload(db, [B3_HIGH])).json()).ok, true);
  const mixed = {
    inputTokens: 50,
    outputTokens: 50000,
    cacheCreationTokens: 5,
    cacheReadTokens: 60,
    totalTokens: 50115,
    totalCost: 99.99,
  };
  const res = await b3Upload(db, [mixed]);
  assert.equal(res.status, 200);

  const row = b3Stored(usage);
  assert.equal(row.input_tokens, 100000);
  assert.equal(row.output_tokens, 50000);
  assert.equal(row.cache_creation_tokens, 5000);
  assert.equal(row.cache_read_tokens, 30000);
  assert.equal(row.total_tokens, 155000);
  assert.equal(row.cost_usd, 99.99);
});

test('B3: /api/upload is the only daily_usage writer (no UPDATE path)', () => {
  // Audit pin: every other daily_usage reference in src/ is a SELECT/JOIN or
  // the median pre-read. A second writer (or an UPDATE/DELETE line) would be
  // a new lowering path outside the max-merge upsert.
  const inserts = workerSource.match(/INSERT INTO daily_usage/g) || [];
  assert.equal(inserts.length, 1, 'expected exactly one INSERT INTO daily_usage in src/index.ts');
  for (const line of stripComments(workerSource).split('\n')) {
    assert.ok(
      !(/\bUPDATE\b/.test(line) && /daily_usage/.test(line)),
      `no UPDATE may touch daily_usage: ${line.trim()}`,
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
