// Per-model usage by platform: parsing, the never-lower upsert guard, SQL
// aggregation, and the analytics section.
//
// Layers, cheapest first:
//   - pure: parser normalization, grouping, rendering, route wiring (fake D1)
//   - source tripwire: the upsert may never blindly assign model_breakdowns
//   - behavioral: the REAL /api/upload handler runs against a capturing fake,
//     and its exact SQL is replayed into real SQLite via the sqlite3 CLI
//     (works on Node 20 CI, which has no node:sqlite; skipped if absent).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-model-usage-'));

async function loadBundle(entryPoint, name) {
  const outdir = path.join(bundleDir, name);
  await build({
    entryPoints: [join(repoRoot, entryPoint)],
    outdir,
    bundle: true,
    entryNames: 'bundle',
    format: 'esm',
    loader: { '.wasm': 'file' },
    platform: 'node',
    logLevel: 'silent',
  });
  return import(pathToFileURL(path.join(outdir, 'bundle.js')).href);
}

let parser;
let models;
let analytics;
let app;

before(async () => {
  [parser, models, analytics, app] = await Promise.all([
    loadBundle('src/parser.ts', 'parser'),
    loadBundle('src/models.ts', 'models'),
    loadBundle('src/analytics.ts', 'analytics'),
    loadBundle('src/index.ts', 'app'),
  ]);
});

after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

// ─── Parser ─────────────────────────────────────────────────────────────────

const OPUS = {
  modelName: 'claude-opus-4-5',
  inputTokens: 60,
  outputTokens: 12,
  cacheCreationTokens: 6,
  cacheReadTokens: 180,
  cost: 0.006,
};
const SONNET = {
  modelName: 'claude-sonnet-4-5',
  inputTokens: 40,
  outputTokens: 8,
  cacheCreationTokens: 4,
  cacheReadTokens: 120,
  cost: 0.004,
};

function row(overrides = {}) {
  return {
    date: '2026-10-10',
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 10,
    cacheReadTokens: 300,
    totalTokens: 430,
    totalCost: 0.01,
    modelsUsed: ['claude-opus-4-5', 'claude-sonnet-4-5'],
    ...overrides,
  };
}

function parseOne(overrides) {
  const report = parser.parseReport(JSON.stringify({ type: 'daily', daily: [row(overrides)] }));
  return report.entries[0];
}

test('ccusage breakdowns have no per-model totalTokens: it is derived from the components', () => {
  const entry = parseOne({
    modelBreakdowns: [
      { ...OPUS, source: 'ignored', isFallback: true },
      SONNET,
    ],
  });
  assert.deepStrictEqual(entry.modelBreakdowns, [
    { ...OPUS, totalTokens: 258 },
    { ...SONNET, totalTokens: 172 },
  ]);
  // Only the displayed fields survive; client extras are dropped.
  assert.deepStrictEqual(Object.keys(entry.modelBreakdowns[0]).sort(), [
    'cacheCreationTokens',
    'cacheReadTokens',
    'cost',
    'inputTokens',
    'modelName',
    'outputTokens',
    'totalTokens',
  ]);
});

test('an explicit per-model totalTokens (native importers) is used as given', () => {
  const entry = parseOne({
    modelsUsed: ['kimi-k2'],
    modelBreakdowns: [
      { modelName: 'kimi-k2', inputTokens: 100, outputTokens: 20, cacheCreationTokens: 10, cacheReadTokens: 300, totalTokens: 430, cost: 0 },
    ],
  });
  assert.equal(entry.modelBreakdowns.length, 1);
  assert.equal(entry.modelBreakdowns[0].totalTokens, 430);
});

test('breakdowns keyed by model name are accepted, including the codex models map', () => {
  const keyed = parseOne({
    modelsUsed: undefined,
    modelBreakdowns: { 'gpt-5': { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 10, cacheReadTokens: 300 } },
  });
  assert.equal(keyed.modelBreakdowns[0].modelName, 'gpt-5');
  assert.equal(keyed.modelBreakdowns[0].totalTokens, 430);

  const codex = parseOne({
    modelsUsed: undefined,
    cacheReadTokens: 0,
    cachedInputTokens: 300,
    models: { 'gpt-5': { inputTokens: 100, cachedInputTokens: 300, outputTokens: 20, cacheCreationTokens: 10, totalTokens: 430 } },
  });
  assert.equal(codex.modelBreakdowns[0].modelName, 'gpt-5');
  assert.equal(codex.modelBreakdowns[0].cacheReadTokens, 300, 'cachedInputTokens aliases cacheReadTokens');
});

test('duplicate models fold together, biggest first, capped at 40 per entry', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({
    modelName: `m-${String(i).padStart(2, '0')}`,
    inputTokens: 2,
  }));
  const entry = parseOne({
    inputTokens: 100,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 100,
    modelsUsed: ['claude-opus-4-5'],
    modelBreakdowns: [...many, { modelName: 'dup', inputTokens: 3 }, { modelName: 'dup', inputTokens: 3 }],
  });
  assert.equal(entry.modelBreakdowns.length, 40);
  assert.equal(entry.modelBreakdowns[0].modelName, 'dup');
  assert.equal(entry.modelBreakdowns[0].totalTokens, 6, 'duplicate rows are summed');
});

test('idle and unnamed models are skipped and long names truncated', () => {
  const entry = parseOne({
    modelBreakdowns: [
      OPUS,
      { modelName: '<synthetic>', inputTokens: 0, outputTokens: 0 },
      { modelName: '   ', inputTokens: 5 },
      { modelName: 'x'.repeat(150), inputTokens: 1 },
    ],
  });
  assert.deepStrictEqual(
    entry.modelBreakdowns.map((m) => m.modelName),
    ['claude-opus-4-5', 'x'.repeat(100)],
  );
});

test('an invalid number voids the whole breakdown without rejecting the upload', () => {
  const entry = parseOne({ modelBreakdowns: [OPUS, { ...SONNET, outputTokens: -8 }] });
  assert.deepStrictEqual(entry.modelBreakdowns, []);
  assert.equal(entry.totalTokens, 430, 'the row itself is still accepted');
});

test('a breakdown that claims more tokens than its row is dropped, not rejected', () => {
  const entry = parseOne({ modelBreakdowns: [{ ...OPUS, inputTokens: 1_000_000 }] });
  assert.deepStrictEqual(entry.modelBreakdowns, []);
  // At exactly the row total it is kept.
  const exact = parseOne({ modelBreakdowns: [OPUS, SONNET] });
  assert.equal(exact.modelBreakdowns.reduce((s, m) => s + m.totalTokens, 0), 430);
});

test('rows without breakdowns parse to an empty list', () => {
  assert.deepStrictEqual(parseOne({}).modelBreakdowns, []);
  assert.deepStrictEqual(parseOne({ modelBreakdowns: 'nope' }).modelBreakdowns, []);
});

test('session reports merge a repeated model across same-day sessions', () => {
  const session = (id, model) => ({
    sessionId: id,
    lastActivity: '2026-10-10',
    inputTokens: 100,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 100,
    totalCost: 0.01,
    modelsUsed: [model.modelName],
    modelBreakdowns: [model],
  });
  const report = parser.parseReport(
    JSON.stringify({
      type: 'session',
      sessions: [
        session('s1', { modelName: 'claude-opus-4-5', inputTokens: 100 }),
        session('s2', { modelName: 'claude-opus-4-5', inputTokens: 100 }),
      ],
    }),
  );
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].modelBreakdowns.length, 1);
  assert.equal(report.entries[0].modelBreakdowns[0].totalTokens, 200);
});

// Regression for a silent failure: if a row's per-model sum disagreed with its
// total (say the CLI folded breakdowns from agents it holds out of the totals),
// reconcileBreakdowns would drop every such day and the biggest platform would
// show nothing, with no error anywhere. This payload has the exact shape
// `ccrank-git` POSTs, checked against real `ccusage daily --json --by-agent`
// output run through rebuildCombinedEntries and runCodexUsageFromEntries (every
// real day kept its breakdown at 100% attribution). Numbers here are synthetic.
test('the payload shape the CLI really posts keeps its breakdowns through reconcile', () => {
  const item = (modelName, input, output, cacheCreation, cacheRead, cost, extra = {}) => ({
    modelName,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    cost,
    ...extra, // real items carry NO totalTokens; merged duplicates add an explicit 0
  });
  const cliRow = (date, items) => {
    const sum = (key) => items.reduce((s, m) => s + m[key], 0);
    const totals = {
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cacheCreationTokens: sum('cacheCreationTokens'),
      cacheReadTokens: sum('cacheReadTokens'),
    };
    const totalTokens = Object.values(totals).reduce((s, n) => s + n, 0);
    const cost = items.reduce((s, m) => s + m.cost, 0);
    return {
      date,
      ...totals,
      totalInputTokens: totals.inputTokens,
      totalOutputTokens: totals.outputTokens,
      totalCacheCreationTokens: totals.cacheCreationTokens,
      totalCacheReadTokens: totals.cacheReadTokens,
      totalTokens,
      totalCost: cost,
      totalCostUSD: cost,
      costUSD: cost,
      modelsUsed: items.map((m) => m.modelName).sort(),
      modelBreakdowns: items,
    };
  };
  const daily = [
    cliRow('2026-10-10', [
      item('claude-opus-4-5', 1200, 300, 400, 9000, 3.25),
      item('claude-sonnet-4-5', 800, 150, 100, 4000, 1.1),
    ]),
    // Two agents shared a model, so the CLI merged them: explicit totalTokens 0.
    cliRow('2026-10-11', [
      item('claude-opus-4-5', 500, 100, 0, 2000, 0.9, { totalTokens: 0, costUSD: 0.9, totalCost: 0.9, totalCostUSD: 0.9 }),
      item('claude-haiku-4-5', 90, 10, 0, 400, 0.05),
    ]),
  ];
  const totals = { totalTokens: daily.reduce((s, r) => s + r.totalTokens, 0) };
  const report = parser.parseReport(JSON.stringify({ daily, totals }));

  assert.equal(report.entries.length, 2);
  report.entries.forEach((entry, i) => {
    assert.equal(
      entry.modelBreakdowns.length,
      daily[i].modelBreakdowns.length,
      `${entry.date}: the breakdown must survive reconcile`,
    );
    assert.equal(
      entry.modelBreakdowns.reduce((s, m) => s + m.totalTokens, 0),
      entry.totalTokens,
      `${entry.date}: per-model tokens must add up to the row total`,
    );
  });
  const merged = report.entries[1].modelBreakdowns.find((m) => m.modelName === 'claude-opus-4-5');
  assert.equal(merged.totalTokens, 2600, 'an explicit totalTokens of 0 falls back to the component sum');
  assert.equal(report.entries[0].platform, 'claude');
});

// ─── Grouping ───────────────────────────────────────────────────────────────

function sqlRow(plat, model, tokens, extra = {}) {
  return { plat, model, input: tokens, output: 0, cache_creation: 0, cache_read: 0, tokens, cost: 0, users: 1, ...extra };
}

test('groupModelUsage buckets by platform, biggest first, and keeps full totals past the cap', () => {
  const rows = [
    sqlRow('claude', 'small', 10),
    sqlRow('claude', 'big', 1000, { cost: 5, users: 3 }),
    sqlRow('claude', 'mid', 100),
    sqlRow('kimi', 'kimi-k2', 50),
  ];
  const summary = models.groupModelUsage(rows, 2);
  assert.deepStrictEqual(summary.platforms.map((p) => p.platform), ['claude', 'kimi']);
  const claude = summary.platforms[0];
  assert.deepStrictEqual(claude.models.map((m) => m.model), ['big', 'mid']);
  assert.equal(claude.modelCount, 3);
  assert.equal(claude.totalTokens, 1110, 'platform total includes the model past the cap');
  assert.equal(claude.costUsd, 5);
  assert.equal(summary.attributedTokens, 1160);
});

test('groupModelUsage skips rows with no model or no tokens', () => {
  const summary = models.groupModelUsage([
    sqlRow('claude', null, 10),
    sqlRow('claude', '', 10),
    sqlRow('claude', 'zero', 0),
    sqlRow('claude', 'ok', 5),
  ]);
  assert.deepStrictEqual(summary.platforms[0].models.map((m) => m.model), ['ok']);
});

// ─── Analytics section ──────────────────────────────────────────────────────

function pageFixture(summary) {
  return {
    range: 30,
    days: [{ date: '2026-10-14', tokens: 4000, cost: 8, users: 2, byPlatform: { claude: 3000, kimi: 1000 } }],
    totals: { tokens: 4000, cost: 8, users: 2 },
    topUsers: [],
    models: summary,
  };
}

test('renders one table per platform in platform order with labels, shares and escaped names', () => {
  const summary = models.groupModelUsage([
    sqlRow('kimi', 'kimi-k2', 1000, { output: 100 }),
    sqlRow('claude', 'claude-opus-4-5', 2000, { output: 200, cache_read: 1000, cost: 10, users: 4 }),
    sqlRow('claude', '<img src=x onerror=alert(1)>', 1000),
  ]);
  const page = analytics.analyticsPage(pageFixture(summary));
  assert.match(page, /Models by Platform/);
  assert.ok(page.indexOf('Claude Code') < page.indexOf('Kimi Code'), 'platform order, not token order');
  assert.ok(page.includes('claude-opus-4-5'));
  assert.ok(!page.includes('<img src=x'), 'model names are escaped');
  assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt;'));
  // opus: 2000 of 3000 claude tokens -> 66.7% share; 1000/2000 cache -> 50.0%.
  assert.ok(page.includes('66.7%'));
  assert.ok(page.includes('50.0%'));
  // $10 over 2000 tokens = $5000 per million.
  assert.ok(page.includes('$5000.00'));
  assert.match(page, /Model detail covers 100\.0% of tokens in this window/);
});

test('zero-cost models and platforms show a dash, not $0.00', () => {
  const summary = models.groupModelUsage([sqlRow('kimi', 'kimi-k2', 1000)]);
  const page = analytics.analyticsPage(pageFixture(summary));
  const kimiBlock = page.slice(page.indexOf('Kimi Code'));
  assert.ok(kimiBlock.includes('cost n/a'));
  assert.ok(!kimiBlock.includes('$0.00'));
  assert.ok(kimiBlock.includes('>—</td>'));
});

test('models past the per-platform cap collapse into a "+N more" row with their tokens', () => {
  const rows = Array.from({ length: 10 }, (_, i) => sqlRow('claude', `model-${i}`, 100 - i));
  const page = analytics.analyticsPage(pageFixture(models.groupModelUsage(rows)));
  // 10 models of 100..91 tokens; the 2 smallest (92 + 91) fall past the cap of 8.
  assert.match(page, /\+2 more models · 183/);
});

test('the table reserves room for the Model column next to its fixed-width columns', () => {
  // Regression: with table-fixed, the Model column gets whatever the fixed
  // columns leave inside min-w. A min-w barely above their sum squeezed model
  // names to one character per line on narrow screens (seen only in a browser).
  const page = analytics.analyticsPage(pageFixture(models.groupModelUsage([sqlRow('claude', 'claude-opus-4-5', 1000)])));
  const table = page.slice(page.indexOf('<table class="w-full min-w-['));
  const minWidth = Number(table.match(/min-w-\[(\d+)px\]/)[1]);
  const header = table.slice(table.indexOf('<thead>'), table.indexOf('</thead>'));
  // Tailwind w-N is N * 4px.
  const fixed = [...header.matchAll(/<th class="[^"]*\bw-(\d+)\b/g)].reduce((sum, m) => sum + Number(m[1]) * 4, 0);
  assert.ok(table.includes('table-fixed'), 'columns must align across platform tables');
  assert.ok(fixed > 0, 'expected fixed-width numeric columns');
  const modelColumn = minWidth - fixed - 24; // px-3 padding on both sides
  assert.ok(modelColumn >= 180, `Model column would get only ${modelColumn}px of content width`);
});

test('coverage reflects how much of the window carries a breakdown', () => {
  const summary = models.groupModelUsage([sqlRow('claude', 'claude-opus-4-5', 1000)]);
  const page = analytics.analyticsPage(pageFixture(summary));
  assert.match(page, /covers 25\.0% of tokens/);
});

test('the section is hidden without a summary and shows a hint when empty', () => {
  const hidden = analytics.analyticsPage(pageFixture(undefined));
  assert.ok(!hidden.includes('Models by Platform'));
  const empty = analytics.analyticsPage(pageFixture({ platforms: [], attributedTokens: 0 }));
  assert.match(empty, /No per-model data yet/);
});

// ─── /analytics route ───────────────────────────────────────────────────────

function analyticsDb({ modelRows, modelError }) {
  const exec = (sql) => ({
    async all() {
      if (/json_each/.test(sql)) {
        if (modelError) throw modelError;
        return { results: modelRows };
      }
      if (/SUM\(cost_usd\) AS c/.test(sql)) {
        return { results: [{ date: '2026-10-14', platform: 'claude', t: 3000, c: 8 }] };
      }
      return { results: [] };
    },
  });
  return {
    prepare(sql) {
      return { bind: () => exec(sql), ...exec(sql) };
    },
  };
}

test('GET /analytics renders the models section from the model query', async () => {
  const db = analyticsDb({ modelRows: [sqlRow('claude', 'claude-opus-4-5', 3000, { cost: 8 })] });
  const res = await app.default.request('https://ccrank.dev/analytics', {}, { DB: db });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Models by Platform/);
  assert.match(html, /claude-opus-4-5/);
});

test('GET /analytics survives a failing model query (e.g. 0014 not applied yet)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = analyticsDb({ modelError: new Error('D1_ERROR: no such column: model_breakdowns') });
  const res = await app.default.request('https://ccrank.dev/analytics', {}, { DB: db });
  assert.equal(res.status, 200, 'the page must not 500 because of the optional section');
  const html = await res.text();
  assert.match(html, /Daily Consumption/);
  assert.ok(!html.includes('Models by Platform'));
});

// ─── Upsert guard: source tripwire (runs everywhere) ────────────────────────

const workerSource = readFileSync(join(repoRoot, 'src', 'index.ts'), 'utf8');

test('the upsert never blindly assigns model_breakdowns and keeps the never-lower guard', () => {
  assert.doesNotMatch(
    workerSource,
    /model_breakdowns\s*=\s*excluded\.model_breakdowns/,
    'a blind assignment lets a pruned-logs upload (or an older CLI) lower per-model history',
  );
  const guardStart = workerSource.indexOf('const mergeBreakdowns = `CASE');
  assert.ok(guardStart >= 0, 'mergeBreakdowns CASE block must exist');
  // Other handlers also declare `const stmt = ...prepare(`; take the first
  // one after the guard so the slice is the guard itself.
  const guard = workerSource.slice(
    guardStart,
    workerSource.indexOf('const stmt = c.env.DB.prepare(', guardStart),
  );
  assert.match(guard, /WHEN excluded\.model_breakdowns IS NULL THEN daily_usage\.model_breakdowns/);
  assert.match(guard, /WHEN daily_usage\.model_breakdowns IS NULL THEN excluded\.model_breakdowns/);
  assert.match(
    guard,
    /WHEN excluded\.total_tokens >= daily_usage\.total_tokens THEN excluded\.model_breakdowns/,
  );
  assert.match(guard, /ELSE daily_usage\.model_breakdowns/);
  assert.match(workerSource, /model_breakdowns = \$\{mergeBreakdowns\}/);
});

// ─── Behavioral: real handler SQL replayed into real SQLite ────────────────

let sqlite3Status = null;
function sqlite3Available() {
  if (sqlite3Status === null) {
    sqlite3Status = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;
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

function runSql(dbPath, sql, args = []) {
  const result = spawnSync('sqlite3', [...args, dbPath], { input: sql, encoding: 'utf8' });
  assert.equal(result.status, 0, `sqlite3 failed: ${(result.stderr || '').trim()}`);
  return result.stdout || '';
}

function queryJson(dbPath, sql) {
  const out = runSql(dbPath, sql, ['-json']).trim();
  return out === '' ? [] : JSON.parse(out);
}

// Applies the same chain `npm run db:migrate` does, read from package.json so
// a future migration is picked up automatically.
function freshDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ccrank-model-usage-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'test.db');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const segment of pkg.scripts['db:migrate'].split('&&')) {
    const match = segment.match(/--file=(migrations\/\d{4}_[\w-]+\.sql)/);
    if (match) runSql(dbPath, readFileSync(join(repoRoot, match[1]), 'utf8'));
  }
  return dbPath;
}

const uploader = {
  id: 'user-1',
  google_id: 'google-1',
  email: 'models@example.com',
  display_name: 'Model User',
  avatar_url: null,
  is_admin: 0,
  invites_remaining: 0,
  sharing_enabled: 1,
  git_sharing_enabled: 1,
  share_slug: 'model-user',
  fav_tools: '[]',
};

function capturingDb() {
  const inserts = [];
  const exec = (sql) => ({
    async first() {
      if (/FROM api_tokens/.test(sql)) return { id: 'token-1', user_id: uploader.id };
      if (/FROM users/.test(sql)) return uploader;
      return null;
    },
    async all() {
      return { results: [] };
    },
    async run() {
      return { success: true };
    },
  });
  const db = {
    prepare(sql) {
      return { sql, bindings: [], ...exec(sql), bind: (...bindings) => ({ sql, bindings, ...exec(sql) }) };
    },
    async batch(statements) {
      for (const stmt of statements) {
        if (/INSERT INTO daily_usage/.test(stmt.sql)) inserts.push({ sql: stmt.sql, bindings: stmt.bindings });
      }
      return statements.map(() => ({ success: true }));
    },
  };
  return { db, inserts };
}

async function upload(db, entry) {
  const res = await app.default.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        json: JSON.stringify({ type: 'daily', daily: [entry] }),
        source: 'mac',
        cli_version: '1.7.1', // MIN_CLI_VERSION gate: older clients get 426 before any parsing
      }),
    },
    { DB: db },
  );
  assert.equal(res.status, 200, `upload failed: ${await res.clone().text()}`);
}

// The handler's SQL uses only positional `?`; inline the bound values so the
// exact statement text runs in SQLite.
function inline(sql, bindings) {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const value = bindings[i++];
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
  });
}

function replay(dbPath, inserts) {
  for (const { sql, bindings } of inserts) runSql(dbPath, inline(sql, bindings));
}

function stored(dbPath) {
  const [rowOut] = queryJson(
    dbPath,
    "SELECT total_tokens, model_breakdowns FROM daily_usage WHERE user_id = 'user-1' AND date = '2026-10-10';",
  );
  return {
    total: rowOut.total_tokens,
    breakdowns: rowOut.model_breakdowns === null ? null : JSON.parse(rowOut.model_breakdowns),
  };
}

// One-model day: row total equals the model total, so reconcile always keeps it.
function day(total, modelName = 'claude-opus-4-5') {
  return row({
    inputTokens: total,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: total,
    modelsUsed: [modelName],
    modelBreakdowns: [{ modelName, inputTokens: total }],
  });
}

function dayWithoutBreakdown(total) {
  const entry = day(total);
  delete entry.modelBreakdowns;
  return entry;
}

test('without breakdowns the handler binds NULL, never an empty array', async () => {
  const { db, inserts } = capturingDb();
  await upload(db, dayWithoutBreakdown(430));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].bindings.length, 14);
  assert.equal(inserts[0].bindings[13], null);
});

test('per-model detail never lowers: bigger replaces, smaller and absent never clear it', async (t) => {
  if (skipWithoutSqlite3(t)) return;
  const dbPath = freshDb(t);
  const { db, inserts } = capturingDb();

  await upload(db, day(430, 'first'));
  replay(dbPath, inserts.splice(0));
  assert.deepStrictEqual(stored(dbPath).breakdowns.map((m) => m.modelName), ['first']);

  await upload(db, day(860, 'bigger'));
  replay(dbPath, inserts.splice(0));
  assert.equal(stored(dbPath).total, 860);
  assert.deepStrictEqual(stored(dbPath).breakdowns.map((m) => m.modelName), ['bigger']);

  // Pruned logs: the machine can only reproduce a smaller day. The peak total
  // AND its breakdown must both survive.
  await upload(db, day(100, 'pruned'));
  replay(dbPath, inserts.splice(0));
  assert.equal(stored(dbPath).total, 860);
  assert.deepStrictEqual(stored(dbPath).breakdowns.map((m) => m.modelName), ['bigger']);

  // Same total re-uploaded (cache reset, renamed models): it refreshes.
  await upload(db, day(860, 'renamed'));
  replay(dbPath, inserts.splice(0));
  assert.deepStrictEqual(stored(dbPath).breakdowns.map((m) => m.modelName), ['renamed']);

  // An older CLI sends no breakdown with a higher total: totals advance, the
  // stored breakdown is kept rather than wiped.
  await upload(db, dayWithoutBreakdown(900));
  replay(dbPath, inserts.splice(0));
  assert.equal(stored(dbPath).total, 900);
  assert.deepStrictEqual(stored(dbPath).breakdowns.map((m) => m.modelName), ['renamed']);
});

test('a row stored before breakdowns existed is filled even by a smaller report', async (t) => {
  if (skipWithoutSqlite3(t)) return;
  const dbPath = freshDb(t);
  const { db, inserts } = capturingDb();

  await upload(db, dayWithoutBreakdown(1000));
  replay(dbPath, inserts.splice(0));
  assert.equal(stored(dbPath).breakdowns, null);

  // Local logs were pruned since; this is all the machine can still report.
  await upload(db, day(400, 'late-fill'));
  replay(dbPath, inserts.splice(0));
  assert.equal(stored(dbPath).total, 1000, 'the peak total is untouched');
  assert.deepStrictEqual(stored(dbPath).breakdowns.map((m) => m.modelName), ['late-fill']);
});

// ─── Behavioral: aggregation SQL on real SQLite ─────────────────────────────

test('MODEL_USAGE_SQL groups by platform and model and ignores unusable rows', async (t) => {
  if (skipWithoutSqlite3(t)) return;
  const dbPath = freshDb(t);
  const bd = (...items) => JSON.stringify(items).replace(/'/g, "''");
  const m = (modelName, input, output, cacheCreation, cacheRead, cost) => ({
    modelName,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    totalTokens: input + output + cacheCreation + cacheRead,
    cost,
  });
  const usageRow = (id, user, date, platform, total, json) =>
    `INSERT INTO daily_usage (id, upload_id, user_id, date, source, platform, total_tokens, model_breakdowns)
     VALUES ('${id}', 'up', '${user}', '${date}', 'mac', '${platform}', ${total}, ${json === null ? 'NULL' : `'${json}'`});`;
  runSql(
    dbPath,
    [
      usageRow('r1', 'u1', '2026-10-10', 'claude', 1100, bd(m('claude-opus-4-5', 100, 50, 10, 840, 2.5), m('claude-sonnet-4-5', 10, 5, 0, 85, 0.2))),
      usageRow('r2', 'u2', '2026-10-11', 'claude', 1000, bd(m('claude-opus-4-5', 200, 100, 0, 700, 5))),
      usageRow('r3', 'u1', '2026-10-12', 'kimi', 1000, bd(m('kimi-k2', 300, 100, 0, 600, 0))),
      usageRow('r4', 'u1', '2026-10-12', 'codex', 500, null), // pre-0014 row
      usageRow('r5', 'u1', '2026-10-13', 'claude', 400, 'not json{{'), // hand-edited corruption
      usageRow('r6', 'u3', '2026-09-01', 'claude', 4, bd(m('claude-opus-4-5', 1, 1, 1, 1, 1))), // before the window
      usageRow('r7', 'u1', '2026-10-14', 'claude', 0, bd(m('claude-opus-4-5', 1, 1, 1, 1, 1))), // zero-total correction day
    ].join('\n'),
  );
  const rows = queryJson(dbPath, models.MODEL_USAGE_SQL.replace('?', "'2026-10-01'"));
  const summary = models.groupModelUsage(rows);

  assert.deepStrictEqual(summary.platforms.map((p) => p.platform), ['claude', 'kimi']);
  const claude = summary.platforms[0];
  assert.deepStrictEqual(claude.models.map((x) => x.model), ['claude-opus-4-5', 'claude-sonnet-4-5']);
  const opus = claude.models[0];
  assert.equal(opus.totalTokens, 2000, 'summed across both users and days');
  assert.equal(opus.outputTokens, 150);
  assert.equal(opus.cacheReadTokens, 1540);
  assert.equal(opus.costUsd, 7.5);
  assert.equal(opus.users, 2, 'distinct users, not rows');
  assert.equal(summary.attributedTokens, 3100);
});
