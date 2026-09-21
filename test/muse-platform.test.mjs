import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-muse-'));
let html;
let parser;
let utils;

async function loadBundle(entryPoint, name) {
  const outdir = path.join(bundleDir, name);
  await build({
    entryPoints: [entryPoint],
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

let app;

before(async () => {
  [app, html, parser, utils] = await Promise.all([
    loadBundle('src/index.ts', 'app'),
    loadBundle('src/html.ts', 'html'),
    loadBundle('src/parser.ts', 'parser'),
    loadBundle('src/utils.ts', 'utils'),
  ]);
});

after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

test('advertises the muse platform so the CLI can probe before uploading', async () => {
  const response = await app.default.request('https://ccrank.dev/api/platforms', {}, {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(body.platforms.includes('muse'), 'platforms must include muse');
});

test('accepts muse and still rejects anything else', () => {
  assert.equal(utils.isValidPlatform('muse'), true);
  for (const platform of ['', 'MUSE', 'metamate', undefined]) {
    assert.equal(utils.isValidPlatform(platform), false, String(platform));
  }
});

test('detects Muse Code models without refiling them as another platform', () => {
  assert.equal(parser.detectPlatform(['muse-spark-1.3-contributor']), 'muse');
  assert.equal(parser.detectPlatform(['muse-spark-1.3']), 'muse');
  assert.equal(parser.detectPlatform(['MUSE-Spark-1.3']), 'muse');
  assert.equal(parser.detectPlatform(['muse-unknown']), 'muse');
  // A model Pi merely fronts is credited to the vendor that owns it.
  assert.equal(parser.detectPlatform(['pi-meta-muse-spark-1-3']), 'muse');
  // Muse is checked before kimi/grok/glm (matching piPlatformForModel), so a
  // hybrid name resolves to muse on both sides.
  assert.equal(parser.detectPlatform(['kimi-muse-bridge-1']), 'muse');
  // Bare vendor names without a muse marker stay on their platforms.
  assert.equal(parser.detectPlatform(['claude-opus-5']), 'claude');
  assert.equal(parser.detectPlatform(['grok-4.6']), 'grok');
  assert.equal(parser.detectPlatform(['gpt-5.5']), 'codex');
});

test('parses a Muse report into the muse platform and keeps it token-only', () => {
  const report = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [{
      date: '2026-09-09',
      inputTokens: 4308,
      outputTokens: 151,
      cacheReadTokens: 33777,
      cacheCreationTokens: 0,
      totalTokens: 38236,
      totalCost: 0,
      modelsUsed: ['muse-spark-1.3-contributor'],
    }],
  }));

  assert.equal(report.platform, 'muse');
  assert.equal(report.entries[0].platform, 'muse');
  assert.equal(report.entries[0].totalTokens, 38236);
  assert.equal(report.entries[0].costUsd, 0);
});

test('uploads land on the muse platform and max-merge like every other platform', async () => {
  const upserts = [];
  let upsertSql = '';
  const user = {
    id: 'u-muse', google_id: 'g-1', email: 'muse@example.com',
    display_name: 'Muse User', avatar_url: null, is_admin: 0,
    invites_remaining: 0, sharing_enabled: 0, git_sharing_enabled: 0,
    share_slug: null, fav_tools: '[]',
  };
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        bindings: [],
        bind(...bindings) {
          const bound = Object.create(statement);
          bound.bindings = bindings;
          if (sql.includes('INSERT INTO daily_usage')) {
            upserts.push(bound);
            upsertSql = sql;
          }
          return bound;
        },
        async first() {
          if (sql.includes('FROM api_tokens')) return { id: 'tok-1', user_id: user.id };
          if (sql.includes('FROM users')) return user;
          return null;
        },
        async run() {
          return { success: true };
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
    async batch(statements) {
      return statements.map(() => ({ success: true }));
    },
  };

  // modelsUsed deliberately detects as codex: only the explicit platform
  // override (the path the Go CLI uses) may land this row on muse.
  const report = JSON.stringify({
    type: 'daily',
    daily: [{
      date: '2026-09-09',
      inputTokens: 4308,
      outputTokens: 151,
      cacheReadTokens: 33777,
      cacheCreationTokens: 0,
      totalTokens: 38236,
      totalCost: 0,
      modelsUsed: ['gpt-5.5'],
    }],
  });
  const response = await app.default.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ json: report, source: 'ccrank-git', platform: 'muse', cli_version: '1.7.1' }),
    },
    { DB: db },
  );
  const body = await response.json();

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.platform, 'muse');
  assert.equal(upserts.length, 1, 'one daily row upserted');
  // Bind order: id, upload_id, user_id, date, source, platform, input,
  // output, cacheCreation, cacheRead, total, cost, modelsUsed.
  const row = upserts[0].bindings;
  assert.equal(row[3], '2026-09-09');
  assert.equal(row[5], 'muse', 'row lands on the muse platform, not refiled as claude');
  assert.equal(row[10], 38236);
  assert.ok(row[12].includes('gpt-5.5'));
  // The muse path max-merges: a later lower upload can never lower the row.
  for (const column of ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'total_tokens', 'cost_usd']) {
    assert.ok(
      upsertSql.includes(`MAX(excluded.${column}, daily_usage.${column})`),
      `${column} max-merges on the muse upload path`,
    );
  }

  // Control: without the override the same report detects as codex, proving
  // the override above is what landed the row on muse.
  upserts.length = 0;
  const control = await app.default.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ json: report, source: 'ccrank-git', cli_version: '1.7.1' }),
    },
    { DB: db },
  );
  assert.equal(control.status, 200);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].bindings[5], 'codex');
});

test('leaderboard offers a filter tab and row dot for Muse Code', () => {
  const page = html.leaderboardPage([{
    rank: 1,
    display_name: 'Muse User',
    avatar_url: null,
    total_cost: 0,
    total_tokens: 38_236,
    total_output_tokens: 151,
    days_active: 1,
    last_active: '2026-09-09',
    output_per_dollar: 0,
    cache_rate: 0.88,
    output_ratio: 0.005,
    meets_efficiency_threshold: false,
    platforms: ['muse'],
  }]);

  assert.match(page, /platform=muse/, 'muse filter tab');
  assert.ok(page.includes('title="Muse Code"'), 'muse row dot');
});
