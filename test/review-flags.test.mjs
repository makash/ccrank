// Review-only anomaly queue: uploads flag suspicious rows for admin review
// but NEVER reject on anomaly (every anomaly upload still returns 200).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-review-flags-'));
let app;
let html;
let auth;

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
  [app, html, auth] = await Promise.all([
    loadBundle('src/index.ts', 'app'),
    loadBundle('src/html.ts', 'html'),
    loadBundle('src/auth.ts', 'auth'),
  ]);
});

after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

const SESSION_SECRET = 'test-review-flags-secret';

const normalUser = {
  id: 'user-1',
  google_id: 'google-1',
  email: 'user@example.com',
  display_name: 'Test User',
  avatar_url: null,
  is_admin: 0,
  invites_remaining: 0,
  sharing_enabled: 1,
  git_sharing_enabled: 1,
  share_slug: 'test-user',
  fav_tools: '[]',
};

// D1-faithful mock: bind() returns a fresh bound statement each call, and
// bound statements keep first()/all()/run() like real D1BoundStatements.
function createUploadDatabase({ medianTokens = [] } = {}) {
  const statements = [];
  const batches = [];
  const db = {
    prepare(sql) {
      const exec = {
        async first() {
          if (/FROM api_tokens/.test(sql)) return { id: 'token-1', user_id: normalUser.id };
          if (/FROM users/.test(sql)) return normalUser;
          return null;
        },
        async all() {
          if (/ORDER BY total_tokens/.test(sql)) {
            return { results: medianTokens.map((total_tokens) => ({ total_tokens })) };
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
          const bound = { sql, bindings, ...exec };
          statements.push(bound);
          return bound;
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

function dailyReport(entries) {
  return JSON.stringify({
    type: 'daily',
    daily: entries.map((e) => ({
      date: '2026-09-10',
      inputTokens: e.inputTokens ?? (e.totalTokens - 100),
      outputTokens: e.outputTokens ?? 100,
      cacheReadTokens: e.cacheReadTokens ?? 0,
      cacheCreationTokens: e.cacheCreationTokens ?? 0,
      totalTokens: e.totalTokens,
      totalCost: e.totalCost ?? 1,
      modelsUsed: ['claude-sonnet-4-5'],
    })),
  });
}

async function upload(db, reportJson) {
  return app.default.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer [REDACTED]', 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: reportJson, source: 'secrig' }),
    },
    { DB: db }
  );
}

function flagBatch(batches) {
  return (
    batches.find((batch) => batch.length > 0 && /INSERT INTO review_flags/.test(batch[0].sql)) ||
    null
  );
}

test('flags a >10B token row for review but still returns 200', async () => {
  const { db, batches, statements } = createUploadDatabase();
  const res = await upload(db, dailyReport([{ totalTokens: 11_000_000_000, totalCost: 5 }]));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  // The never-lower invariant still holds alongside flagging.
  const upsert = statements.find(({ sql }) => /INSERT INTO daily_usage/.test(sql));
  assert.match(upsert.sql, /total_tokens = MAX\(excluded\.total_tokens, daily_usage\.total_tokens\)/);
  const flags = flagBatch(batches);
  assert.ok(flags, 'expected a review_flags batch');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].bindings[1], 'user-1');
  assert.equal(flags[0].bindings[2], '2026-09-10');
  assert.equal(flags[0].bindings[3], 'tokens_absolute');
  assert.match(flags[0].bindings[4], /11000000000/);
});

test('flags a >$10000 cost row for review but still returns 200', async () => {
  const { db, batches } = createUploadDatabase();
  const res = await upload(db, dailyReport([{ totalTokens: 150_000_000, totalCost: 15000 }]));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  const flags = flagBatch(batches);
  assert.ok(flags, 'expected a review_flags batch');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].bindings[3], 'cost_absolute');
  assert.match(flags[0].bindings[4], /15000/);
});

test('flags a row above 20x the trailing-30d median', async () => {
  const { db, batches, statements } = createUploadDatabase({
    medianTokens: Array(10).fill(1_000_000),
  });
  const res = await upload(db, dailyReport([{ totalTokens: 25_000_000, totalCost: 50 }]));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  const medianQueries = statements.filter(({ sql }) => /ORDER BY total_tokens/.test(sql));
  const medianQuery = medianQueries[medianQueries.length - 1];
  assert.ok(medianQuery, 'expected one trailing-30d median SELECT');
  assert.match(medianQuery.sql, /user_id = \?/);
  assert.deepEqual(medianQuery.bindings, ['user-1']);
  const flags = flagBatch(batches);
  assert.ok(flags, 'expected a review_flags batch');
  assert.equal(flags[0].bindings[3], 'tokens_vs_median');
  const detail = JSON.parse(flags[0].bindings[4]);
  assert.equal(detail.total_tokens, 25000000);
  assert.equal(detail.median_30d, 1000000);
});

test('skips the median check with fewer than 7 active days', async () => {
  const { db, batches } = createUploadDatabase({
    medianTokens: [1_000_000, 1_000_000, 1_000_000],
  });
  const res = await upload(db, dailyReport([{ totalTokens: 25_000_000, totalCost: 50 }]));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(flagBatch(batches), null);
  assert.equal(batches.length, 1);
});

test('normal rows insert no flags', async () => {
  const { db, batches } = createUploadDatabase({
    medianTokens: Array(10).fill(1_000_000),
  });
  const res = await upload(db, dailyReport([{ totalTokens: 2_000_000, totalCost: 50 }]));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(flagBatch(batches), null);
  assert.equal(batches.length, 1);
});

test('upload still returns 200 when flagging fails (table missing pre-migration)', async () => {
  const batches = [];
  const db = {
    prepare(sql) {
      if (/review_flags/.test(sql)) throw new Error('no such table: review_flags');
      const exec = {
        async first() {
          if (/FROM api_tokens/.test(sql)) return { id: 'token-1', user_id: normalUser.id };
          if (/FROM users/.test(sql)) return normalUser;
          return null;
        },
        async all() {
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
      batches.push(batch);
      return batch.map(() => ({ success: true }));
    },
  };
  const res = await upload(db, dailyReport([{ totalTokens: 2_000_000, totalCost: 50 }]));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(batches.length, 1); // only the daily_usage upsert ran
});

test('exact boundaries do not flag (strict >)', async () => {
  // Exactly 10B tokens with too few active days for the median check.
  {
    const { db, batches } = createUploadDatabase();
    const res = await upload(db, dailyReport([{ totalTokens: 10_000_000_000, totalCost: 5 }]));
    assert.equal(res.status, 200);
    assert.equal(flagBatch(batches), null);
  }
  // Exactly $10000 at exactly $100/M (validation-valid) with median skipped.
  {
    const { db, batches } = createUploadDatabase();
    const res = await upload(db, dailyReport([{ totalTokens: 100_000_000, totalCost: 10000 }]));
    assert.equal(res.status, 200);
    assert.equal(flagBatch(batches), null);
  }
  // Exactly 20x median with 10 active days.
  {
    const { db, batches } = createUploadDatabase({ medianTokens: Array(10).fill(1_000_000) });
    const res = await upload(db, dailyReport([{ totalTokens: 20_000_000, totalCost: 50 }]));
    assert.equal(res.status, 200);
    assert.equal(flagBatch(batches), null);
  }
});

test('exactly 7 active days runs the median check', async () => {
  const { db, batches } = createUploadDatabase({ medianTokens: Array(7).fill(1_000_000) });
  const res = await upload(db, dailyReport([{ totalTokens: 25_000_000, totalCost: 50 }]));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  const flags = flagBatch(batches);
  assert.ok(flags, 'expected a review_flags batch');
  assert.equal(flags[0].bindings[3], 'tokens_vs_median');
});

test('a row hitting both absolute tripwires yields one tokens_absolute flag', async () => {
  const { db, batches } = createUploadDatabase();
  const res = await upload(db, dailyReport([{ totalTokens: 11_000_000_000, totalCost: 15000 }]));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  const flags = flagBatch(batches);
  assert.ok(flags, 'expected a review_flags batch');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].bindings[3], 'tokens_absolute');
});

test('adminPage surfaces flag count and recent rows', () => {
  const adminUser = { ...normalUser, is_admin: 1 };
  const page = html.adminPage(
    adminUser,
    { total_users: 10, total_uploads: 20, total_invites: 3, total_flags: 2 },
    [],
    [
      {
        id: 'f1',
        user_id: 'user-1',
        date: '2026-09-10',
        reason: 'tokens_absolute',
        detail: '{"total_tokens":11000000000}',
        created_at: '2026-09-10 12:00:00',
        display_name: 'Test User',
      },
      {
        id: 'f2',
        user_id: 'user-2',
        date: '2026-09-09',
        reason: 'cost_absolute',
        detail: '{"cost_usd":15000}',
        created_at: '2026-09-09 12:00:00',
        display_name: null,
      },
    ]
  );

  assert.match(page, /Review Flags/);
  assert.match(page, /Review Queue/);
  assert.match(page, /tokens_absolute/);
  assert.match(page, /cost_absolute/);
  assert.match(page, /Test User/);
  assert.match(page, /user-2/);
  assert.match(page, /never rejected/i);
});

test('adminPage stays backward compatible without flags', () => {
  const adminUser = { ...normalUser, is_admin: 1 };
  const page = html.adminPage(
    adminUser,
    { total_users: 1, total_uploads: 1, total_invites: 0 },
    []
  );

  assert.match(page, /No anomalies flagged/);
});

test('GET /admin shows the review queue to admins', async () => {
  const token = await auth.createSessionToken(
    { userId: 'admin-1', email: 'admin@example.com' },
    SESSION_SECRET
  );
  const adminUser = {
    ...normalUser,
    id: 'admin-1',
    email: 'admin@example.com',
    display_name: 'Admin',
    is_admin: 1,
  };
  const flagRow = {
    id: 'f1',
    user_id: 'user-1',
    date: '2026-09-10',
    reason: 'tokens_vs_median',
    detail: '{"total_tokens":25000000}',
    created_at: '2026-09-10 12:00:00',
    display_name: 'Test User',
  };
  const statements = [];
  const db = {
    prepare(sql) {
      const exec = {
        async first() {
          if (/COUNT\(\*\)/.test(sql) && /FROM review_flags/.test(sql)) return { cnt: 1 };
          if (/COUNT\(\*\)/.test(sql)) return { cnt: 7 };
          if (/FROM users/.test(sql)) return adminUser;
          return null;
        },
        async all() {
          if (/FROM review_flags/.test(sql)) return { results: [flagRow] };
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
          const bound = { sql, bindings, ...exec };
          statements.push(bound);
          return bound;
        },
      };
      statements.push(statement);
      return statement;
    },
  };

  const res = await app.default.request(
    'https://ccrank.dev/admin',
    { headers: { Cookie: `session=${token}` } },
    { DB: db, SESSION_SECRET }
  );

  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /tokens_vs_median/);
  assert.match(page, /Test User/);
  assert.match(page, /Review Queue/);
});
