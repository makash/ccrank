// Minimum CLI version gate for POST /api/upload and /api/git/upload.
//
// Both endpoints require a top-level cli_version >= 1.7.1. Missing,
// malformed, or older values are rejected with HTTP 426 before parsing or
// any D1 write, with an actionable body (min_cli_version, seen_cli_version
// when sent, release_url). The gate never touches usage history.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-cli-version-'));
let app;

before(async () => {
  const outdir = path.join(bundleDir, 'app');
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
  app = (await import(pathToFileURL(path.join(outdir, 'bundle.js')).href)).default;
});

after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

const gateUser = {
  id: 'user-1',
  google_id: 'google-1',
  email: 'gate@example.com',
  display_name: 'Gate',
  avatar_url: null,
  is_admin: 0,
  invites_remaining: 0,
  sharing_enabled: 1,
  git_sharing_enabled: 1,
  share_slug: 'gate',
  fav_tools: '[]',
};

// Tables the gate must leave untouched. The auth last_used_at touch on
// api_tokens happens for every authenticated request (including 400s) and
// is pre-existing behavior, not endpoint data.
const DATA_WRITE = /INSERT INTO (daily_usage|uploads|review_flags)\b|INSERT INTO git_|UPDATE git_|DELETE FROM git_/;

function createGateDatabase() {
  const usage = new Map();
  const gitStats = [];
  const statements = [];
  const db = {
    prepare(sql) {
      statements.push(sql);
      const exec = {
        async first() {
          if (/FROM api_tokens/.test(sql)) return { id: 'token-1', user_id: gateUser.id };
          if (/FROM users/.test(sql)) return gateUser;
          if (/FROM git_projects/.test(sql)) return null;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
      };
      return {
        sql,
        bind(...bindings) {
          return { sql, bindings, ...exec };
        },
        ...exec,
      };
    },
    async batch(batch) {
      for (const stmt of batch) {
        statements.push(stmt.sql);
        if (/INSERT INTO daily_usage/.test(stmt.sql)) {
          const b = stmt.bindings;
          const key = [b[2], b[3], b[4], b[5]].join('|');
          const prev = usage.get(key) || { total_tokens: 0, cost_usd: 0 };
          usage.set(key, {
            total_tokens: Math.max(prev.total_tokens, Number(b[10]) || 0),
            cost_usd: Math.max(prev.cost_usd, Number(b[11]) || 0),
          });
        }
        if (/INSERT INTO git_daily_stats/.test(stmt.sql)) {
          gitStats.push(stmt.bindings);
        }
      }
      return batch.map(() => ({ success: true }));
    },
  };
  const dataWrites = () => statements.filter((sql) => DATA_WRITE.test(sql));
  return { db, usage, gitStats, dataWrites };
}

function dailyReport(totalTokens, totalCost = 1) {
  return JSON.stringify({
    type: 'daily',
    daily: [{
      date: '2026-09-10',
      inputTokens: totalTokens - 100,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens,
      totalCost,
      modelsUsed: ['claude-sonnet-4-5'],
    }],
  });
}

async function postUpload(db, body) {
  return app.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer [REDACTED]', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DB: db }
  );
}

function gitProject() {
  const days = [];
  const today = new Date();
  for (let i = 27; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push({ date: d.toISOString().slice(0, 10), commitCount: 1 });
  }
  return { repoName: 'demo', repoSlug: 'demo', description: 'demo repo', days };
}

async function postGitUpload(db, body) {
  return app.request(
    'https://ccrank.dev/api/git/upload',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer [REDACTED]', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DB: db }
  );
}

test('gate: missing cli_version on /api/upload is 426 with zero writes', async () => {
  const { db, usage, dataWrites } = createGateDatabase();
  const res = await postUpload(db, { json: dailyReport(430, 0.01), source: 'secrig' });
  assert.equal(res.status, 426);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.min_cli_version, '1.7.1');
  assert.equal(body.release_url, 'https://github.com/makash/ccrank/releases/latest');
  assert.ok(!('seen_cli_version' in body), 'missing version must not echo a seen value');
  assert.match(body.error, /1\.7\.1/);
  assert.equal(dataWrites().length, 0);
  assert.equal(usage.size, 0);
});

test('gate: malformed cli_version values are 426 with the seen value echoed', async () => {
  for (const seen of ['dev', 'abc', '', '1.7', '1.7.1.2', 'v', '1.7.x', '1.7.1-beta', '>=1.7.1', 123, null]) {
    const { db, usage, dataWrites } = createGateDatabase();
    const res = await postUpload(db, { json: dailyReport(430, 0.01), source: 'secrig', cli_version: seen });
    assert.equal(res.status, 426, `cli_version ${JSON.stringify(seen)} must be rejected`);
    const body = await res.json();
    assert.equal(body.min_cli_version, '1.7.1');
    assert.ok('seen_cli_version' in body, `seen value ${JSON.stringify(seen)} must be echoed`);
    assert.deepEqual(body.seen_cli_version, seen);
    assert.equal(dataWrites().length, 0);
    assert.equal(usage.size, 0);
  }
});

test('gate: older cli_version values are 426 with zero writes', async () => {
  for (const seen of ['1.7.0', 'v1.7.0', '1.6.9', '1.0.0', '0.9.0', 'v0.1.0']) {
    const { db, dataWrites } = createGateDatabase();
    const res = await postUpload(db, { json: dailyReport(430, 0.01), source: 'secrig', cli_version: seen });
    assert.equal(res.status, 426, `cli_version ${seen} must be rejected`);
    const body = await res.json();
    assert.equal(body.seen_cli_version, seen);
    assert.equal(dataWrites().length, 0);
  }
});

test('gate: 1.7.1+ cli_version values succeed and write the row', async () => {
  for (const seen of ['1.7.1', 'v1.7.1', '1.7.2', '1.8.0', '2.0.0', '10.20.30', '  1.7.1  ']) {
    const { db, usage } = createGateDatabase();
    const res = await postUpload(db, { json: dailyReport(430, 0.01), source: 'secrig', cli_version: seen });
    assert.equal(res.status, 200, `cli_version ${JSON.stringify(seen)} must be accepted`);
    assert.equal((await res.json()).ok, true);
    const row = usage.get('user-1|2026-09-10|secrig|claude');
    assert.ok(row, 'usage row must be written');
    assert.equal(row.total_tokens, 430);
  }
});

test('gate: version check runs before report parsing', async () => {
  const { db, dataWrites } = createGateDatabase();
  // Invalid report body AND stale version: the gate must win (426, not 400).
  const res = await postUpload(db, { json: 'not-json-at-all', source: 'secrig', cli_version: '1.7.0' });
  assert.equal(res.status, 426);
  assert.equal(dataWrites().length, 0);
});

test('gate: /api/git/upload requires cli_version with zero writes on reject', async () => {
  for (const extra of [{}, { cli_version: '1.7.0' }, { cli_version: 'dev' }]) {
    const { db, gitStats, dataWrites } = createGateDatabase();
    const res = await postGitUpload(db, { machine: 'rig', projects: [gitProject()], ...extra });
    assert.equal(res.status, 426, `git upload ${JSON.stringify(extra)} must be rejected`);
    const body = await res.json();
    assert.equal(body.min_cli_version, '1.7.1');
    assert.equal(dataWrites().length, 0);
    assert.equal(gitStats.length, 0);
  }

  const { db, gitStats } = createGateDatabase();
  const ok = await postGitUpload(db, { machine: 'rig', cli_version: 'v1.7.1', projects: [gitProject()] });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
  assert.equal(gitStats.length, 28, 'all 28 daily git rows must be written');
});

test('gate: never-lower still holds for versioned uploads', async () => {
  const { db, usage } = createGateDatabase();
  const high = await postUpload(db, { json: dailyReport(155000, 12.5), source: 'secrig', cli_version: '1.7.1' });
  assert.equal(high.status, 200);
  const low = await postUpload(db, { json: dailyReport(430, 0.01), source: 'secrig', cli_version: '1.7.1' });
  assert.equal(low.status, 200);
  const row = usage.get('user-1|2026-09-10|secrig|claude');
  assert.equal(row.total_tokens, 155000, 'lower repeat must not move the peak');
  assert.equal(row.cost_usd, 12.5);
});
