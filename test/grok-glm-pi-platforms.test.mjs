import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-grok-glm-pi-'));
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

test('advertises every supported platform so the CLI can probe before uploading', async () => {
  const response = await app.default.request('https://ccrank.dev/api/platforms', {}, {});
  const body = await response.json();

  assert.equal(response.status, 200);
  // The CLI holds back any platform missing from this list, because an older
  // server would drop the explicit platform and refile the rows as `claude`,
  // letting a replacing upload overwrite the user's combined totals.
  assert.deepEqual(body.platforms, ['claude', 'codex', 'kimi', 'grok', 'glm', 'pi', 'opencode', 'cursor']);
});

test('a zero-token day never counts as an active day', async () => {
  // Splitting agents into their own platforms uploads a zero row for any date
  // whose usage moved out of the combined bucket, so that a stale inflated row
  // is overwritten. Those rows must not invent activity: days_active gates the
  // efficiency rankings and last_active drives the "time ago" column.
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
          return { results: [] };
        },
      };
      statements.push(statement);
      return statement;
    },
  };

  await app.default.request('https://ccrank.dev/api/leaderboard', {}, { DB: db });

  const sql = statements[0].sql;
  assert.match(sql, /COUNT\(DISTINCT CASE WHEN d\.total_tokens > 0 THEN d\.date END\) as days_active/);
  assert.match(sql, /MAX\(CASE WHEN d\.total_tokens > 0 THEN d\.date END\) as last_active/);
});

test('accepts every platform the CLI uploads and rejects anything else', () => {
  for (const platform of ['claude', 'codex', 'kimi', 'grok', 'glm', 'pi', 'opencode', 'cursor']) {
    assert.equal(utils.isValidPlatform(platform), true, platform);
  }
  for (const platform of ['', 'gemini', 'PI', undefined, 'claude; DROP TABLE']) {
    assert.equal(utils.isValidPlatform(platform), false, String(platform));
  }
});

test('detects Cursor Agent and CLI models without refiling them as Claude or Codex', () => {
  assert.equal(parser.detectPlatform(['composer-2.5']), 'cursor');
  assert.equal(parser.detectPlatform(['composer']), 'cursor');
  assert.equal(parser.detectPlatform(['cursor-grok-4.6-xhigh']), 'cursor');
  assert.equal(parser.detectPlatform(['cursor/claude-4-opus']), 'cursor');
  // Bare vendor names without a cursor-/composer- marker stay on their platforms.
  assert.equal(parser.detectPlatform(['grok-4.6']), 'grok');
  assert.equal(parser.detectPlatform(['claude-opus-5']), 'claude');
  assert.equal(parser.detectPlatform(['gpt-5.5']), 'codex');
});

test('detects Grok and GLM models from their own CLIs', () => {
  assert.equal(parser.detectPlatform(['grok-4.6-build']), 'grok');
  assert.equal(parser.detectPlatform(['GLM-5.3']), 'glm');
  assert.equal(parser.detectPlatform(['claude-opus-5']), 'claude');
  assert.equal(parser.detectPlatform(['gpt-5.5']), 'codex');
});

test('credits a model Pi merely fronts to the vendor that owns it', () => {
  // ccusage prefixes Pi models with "[pi] "; the ccrank importer slugifies to
  // "pi-<provider>-<model>". Both must resolve to the owning vendor.
  assert.equal(parser.detectPlatform(['[pi] GLM-5.2-NVFP4']), 'glm');
  assert.equal(parser.detectPlatform(['pi-hetzner-glm-5-2-nvfp4']), 'glm');
  assert.equal(parser.detectPlatform(['[pi] kimi-k2']), 'kimi');
  assert.equal(parser.detectPlatform(['pi-xai-grok-4-6']), 'grok');
  // Everything else Pi runs stays on the Pi platform.
  assert.equal(parser.detectPlatform(['[pi] DeepSeek-V4-Flash-0731']), 'pi');
  assert.equal(parser.detectPlatform(['pi-hetzner-deepseek-v4-flash-0731']), 'pi');
  // Including OpenAI models, which are Pi usage rather than Codex CLI usage.
  // Both naming forms must agree, and both must match piPlatformForModel.
  assert.equal(parser.detectPlatform(['[pi] gpt-5.2']), 'pi');
  assert.equal(parser.detectPlatform(['[pi] gpt-5.2-codex']), 'pi');
  assert.equal(parser.detectPlatform(['pi-openai-gpt-5-2']), 'pi');
  assert.equal(parser.detectPlatform(['pi-openai-o3-mini']), 'pi');
});

test('detects OpenCode models by their provider prefix', () => {
  assert.equal(parser.detectPlatform(['opencode/x-preview-f-free']), 'opencode');
  assert.equal(parser.detectPlatform(['OpenCode/qwen3-coder-480b']), 'opencode');
  // Vendor checks still win over a bare mention elsewhere in the name.
  assert.equal(parser.detectPlatform(['kimi-k2-through-opencode']), 'kimi');
});

test('keeps detecting Codex CLI models that never went through Pi', () => {
  assert.equal(parser.detectPlatform(['gpt-5.5']), 'codex');
  assert.equal(parser.detectPlatform(['gpt-5.6-sol']), 'codex');
  assert.equal(parser.detectPlatform(['codex-mini']), 'codex');
  assert.equal(parser.detectPlatform(['o3-mini']), 'codex');
  assert.equal(parser.detectPlatform(['openai/gpt-oss-120b']), 'codex');
});

test('parses a Grok report into the Grok platform with its reported cost', () => {
  const report = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [{
      date: '2026-08-14',
      inputTokens: 300,
      outputTokens: 200,
      cacheReadTokens: 700,
      cacheCreationTokens: 0,
      totalTokens: 1200,
      totalCost: 1.5,
      modelsUsed: ['grok-4.6-build'],
    }],
  }));

  assert.equal(report.platform, 'grok');
  assert.equal(report.entries[0].platform, 'grok');
  assert.equal(report.entries[0].totalTokens, 1200);
  assert.equal(report.entries[0].costUsd, 1.5);
});

test('parses a GLM report into the GLM platform and keeps it token-only', () => {
  const report = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [{
      date: '2026-08-14',
      inputTokens: 119,
      outputTokens: 27,
      cacheReadTokens: 192,
      cacheCreationTokens: 40,
      totalTokens: 378,
      totalCost: 0,
      modelsUsed: ['GLM-5.3'],
    }],
  }));

  assert.equal(report.platform, 'glm');
  assert.equal(report.entries[0].totalTokens, 378);
  assert.equal(report.entries[0].costUsd, 0);
});

test('parses a Cursor report into the Cursor platform', () => {
  const report = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [{
      date: '2026-09-04',
      inputTokens: 40505,
      outputTokens: 11740,
      cacheReadTokens: 37888,
      cacheCreationTokens: 200,
      totalTokens: 90333,
      totalCost: 0.170394,
      modelsUsed: ['cursor-grok-4.6-xhigh', 'composer-2.5'],
    }],
  }));

  assert.equal(report.platform, 'cursor');
  assert.equal(report.entries[0].platform, 'cursor');
  assert.equal(report.entries[0].totalTokens, 90333);
  assert.equal(report.entries[0].costUsd, 0.170394);
});

test('leaderboard offers a filter tab and legend swatch for every platform', () => {
  const page = html.leaderboardPage([{
    rank: 1,
    display_name: 'Multi Agent User',
    avatar_url: null,
    total_cost: 293.67,
    total_tokens: 519_150_087,
    total_output_tokens: 5_700_000,
    days_active: 5,
    last_active: '2026-08-14',
    output_per_dollar: 19_000,
    cache_rate: 0.9,
    output_ratio: 0.01,
    meets_efficiency_threshold: true,
    platforms: ['grok', 'glm', 'pi', 'opencode', 'cursor'],
  }]);

  for (const [platform, label] of [['grok', 'Grok CLI'], ['glm', 'GLM (Z Code)'], ['pi', 'Pi'], ['opencode', 'OpenCode'], ['cursor', 'Cursor']]) {
    assert.match(page, new RegExp(`platform=${platform}`), `${platform} filter tab`);
    assert.ok(page.includes(`title="${label}"`), `${platform} row dot`);
  }
  // A platform the user has no usage on must not get a row dot.
  assert.ok(!page.includes('title="Kimi Code"'));
});

test('profile platform breakdown names the new platforms', () => {
  const dashboard = html.dashboardPage(
    {
      id: 'user-1',
      display_name: 'Multi Agent User',
      email: 'user@example.com',
      avatar_url: null,
      is_admin: 0,
      invites_remaining: 0,
      sharing_enabled: 1,
      git_sharing_enabled: 1,
      share_slug: 'multi-agent-user',
      fav_tools: '[]',
    },
    {
      total_cost: 293.67,
      total_tokens: 519_150_087,
      total_output_tokens: 5_700_000,
      days_active: 5,
      rank: 1,
      upload_count: 3,
      platformBreakdown: {
        grok: { total_cost: 293.67, total_tokens: 519_150_087, total_output_tokens: 5_700_000, days_active: 5 },
        glm: { total_cost: 0, total_tokens: 350_770, total_output_tokens: 4_941, days_active: 1 },
        pi: { total_cost: 0.13, total_tokens: 69_063_532, total_output_tokens: 385_877, days_active: 3 },
        cursor: { total_cost: 12.5, total_tokens: 8_000_000, total_output_tokens: 400_000, days_active: 2 },
      },
    }
  );

  assert.match(dashboard, /Grok CLI/);
  assert.match(dashboard, /GLM \(Z Code\)/);
  assert.match(dashboard, /Cursor/);
});
