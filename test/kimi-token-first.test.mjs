import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-kimi-token-first-'));
let app;
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

test('detects native Moonshot Kimi models as the Kimi platform', () => {
  const report = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [{
      date: '2026-08-12',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheCreationTokens: 10,
      totalTokens: 430,
      totalCost: 0,
      modelsUsed: ['moonshot-ai/kimi-k3'],
    }],
  }));

  assert.equal(report.platform, 'kimi');
  assert.equal(report.entries[0].platform, 'kimi');
  assert.equal(report.entries[0].totalTokens, 430);
  assert.equal(report.entries[0].costUsd, 0);
});

test('uses token totals for titles and makes tokens the default leaderboard surface', () => {
  assert.equal(utils.getTitle(100_000_000).label, 'Token Whale');
  assert.equal(utils.getTitle(0).label, 'Apprentice');

  const page = html.leaderboardPage([{
    rank: 1,
    display_name: 'Kimi User',
    avatar_url: null,
    total_cost: 0,
    total_tokens: 100_000_000,
    total_output_tokens: 1_000_000,
    days_active: 4,
    last_active: '2026-08-12',
    output_per_dollar: 0,
    cache_rate: 0.5,
    output_ratio: 0.1,
    meets_efficiency_threshold: false,
    platforms: ['kimi'],
  }]);

  assert.match(page, /Token Whale/);
  assert.match(page, /title="Kimi Code"/);
  assert.match(page, />Kimi<\/a>/);
  assert.ok(page.indexOf('>Tokens</th>') < page.indexOf('>Cost</th>'));
  assert.match(page, /sort=tokens[^\"]*" class="[^"]*bg-purple-600/);
});

test('dashboard and share card keep tokens primary while showing Kimi separately', () => {
  const user = {
    id: 'user-1',
    display_name: 'Kimi User',
    email: 'kimi@example.com',
    avatar_url: null,
    is_admin: 0,
    invites_remaining: 0,
    sharing_enabled: 1,
    git_sharing_enabled: 1,
    share_slug: 'kimi-user',
    fav_tools: '[]',
  };
  const dashboard = html.dashboardPage(user, {
    total_cost: 12.5,
    total_tokens: 100_000_000,
    total_output_tokens: 2_000_000,
    days_active: 5,
    rank: 1,
    upload_count: 2,
    platformBreakdown: {
      claude: { total_cost: 12.5, total_tokens: 60_000_000, total_output_tokens: 1_000_000, days_active: 5 },
      kimi: { total_cost: 0, total_tokens: 40_000_000, total_output_tokens: 1_000_000, days_active: 3 },
    },
  });

  assert.match(dashboard, /Kimi Code/);
  assert.ok(dashboard.indexOf('Total Tokens') < dashboard.indexOf('Estimated Cost'));

  const card = html.cardPage(
    { display_name: 'Kimi User', avatar_url: null, share_slug: 'kimi-user' },
    {
      total_cost: 12.5,
      total_tokens: 100_000_000,
      total_output_tokens: 2_000_000,
      days_active: 5,
      rank: 1,
      last_active: '2026-08-12',
    },
    'full'
  );

  assert.match(card, /100\.0M/);
  assert.match(card, /total tokens across AI coding tools/);
  assert.ok(card.indexOf('100.0M') < card.indexOf('Estimated Cost'));
});

test('API leaderboard accepts Kimi and keeps zero-cost token usage ranked', async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
        async all() {
          return {
            results: [{
              id: 'kimi-user',
              display_name: 'Kimi User',
              avatar_url: null,
              share_slug: null,
              total_cost: 0,
              total_tokens: 430,
              total_output_tokens: 20,
              total_cache_read: 300,
              days_active: 1,
              last_active: '2026-08-12',
              platforms: 'kimi',
              output_per_dollar: 0,
              cache_rate: 0.7,
              output_ratio: 0.15,
            }],
          };
        },
      };
      statements.push(statement);
      return statement;
    },
  };

  const response = await app.default.request(
    'https://ccrank.dev/api/leaderboard?platform=kimi',
    {},
    { DB: db }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.entries[0].rank, 1);
  assert.equal(body.entries[0].total_cost, 0);
  assert.equal(body.entries[0].total_tokens, 430);
  assert.deepEqual(statements[0].bindings, ['claude', 'kimi']);
  assert.match(statements[0].sql, /HAVING total_tokens > 0/);
  assert.match(statements[0].sql, /ORDER BY total_tokens DESC/);
});

test('Kimi CLI uploads can replace migrated aggregates while legacy uploads keep max merge', async () => {
  function createUploadDatabase() {
    const statements = [];
    const batches = [];
    const db = {
      prepare(sql) {
        const statement = {
          sql,
          bindings: [],
          bind(...bindings) {
            this.bindings = bindings;
            return this;
          },
          async first() {
            if (/FROM api_tokens/.test(sql)) return { id: 'token-1', user_id: 'user-1' };
            if (/FROM users/.test(sql)) {
              return {
                id: 'user-1',
                google_id: 'google-1',
                email: 'kimi@example.com',
                display_name: 'Kimi User',
                avatar_url: null,
                is_admin: 0,
                invites_remaining: 0,
                sharing_enabled: 1,
                git_sharing_enabled: 1,
                share_slug: 'kimi-user',
                fav_tools: '[]',
              };
            }
            return null;
          },
          async run() {
            return { success: true };
          },
        };
        statements.push(statement);
        return statement;
      },
      async batch(batch) {
        batches.push(batch);
        return batch.map(() => ({ success: true }));
      },
    };
    return { db, statements, batches };
  }

  const report = JSON.stringify({
    type: 'daily',
    daily: [{
      date: '2026-08-12',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheCreationTokens: 10,
      totalTokens: 430,
      totalCost: 0,
      modelsUsed: ['moonshot-ai/kimi-k3'],
    }],
  });

  const replacement = createUploadDatabase();
  const replacementResponse = await app.default.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: report, source: 'secrig', platform: 'kimi', replace: true }),
    },
    { DB: replacement.db }
  );
  const replacementBody = await replacementResponse.json();
  const replacementUpsert = replacement.statements.find(({ sql }) => /INSERT INTO daily_usage/.test(sql));

  assert.equal(replacementResponse.status, 200);
  assert.equal(replacementBody.platform, 'kimi');
  assert.match(replacementUpsert.sql, /total_tokens = excluded\.total_tokens/);
  assert.equal(replacement.batches[0][0].bindings[5], 'kimi');
  assert.equal(replacement.batches[0][0].bindings[10], 430);
  assert.equal(replacement.batches[0][0].bindings[11], 0);

  const legacy = createUploadDatabase();
  await app.default.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: report, source: 'secrig', platform: 'kimi' }),
    },
    { DB: legacy.db }
  );
  const legacyUpsert = legacy.statements.find(({ sql }) => /INSERT INTO daily_usage/.test(sql));
  assert.match(legacyUpsert.sql, /total_tokens = MAX\(excluded\.total_tokens, daily_usage\.total_tokens\)/);
});
