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
    batches.find((batch) => batch.length > 0 && /INSERT (OR IGNORE )?INTO review_flags/.test(batch[0].sql)) ||
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

// H3 dedup: UNIQUE(user_id, date, reason) + INSERT OR IGNORE keeps CLI
// re-uploads from burying the review queue with duplicate rows.
function createDedupDatabase() {
  const statements = [];
  const batches = [];
  const batchErrors = [];
  const flagRows = new Map(); // key: user_id|date|reason -> bindings
  const db = {
    prepare(sql) {
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
      // Simulate the UNIQUE(user_id, date, reason) constraint from 0011:
      // duplicates are silently ignored with OR IGNORE, and raise (as real
      // D1 would) on a plain INSERT.
      if (batch.length > 0 && /review_flags/.test(batch[0].sql)) {
        const orIgnore = /INSERT OR IGNORE INTO review_flags/.test(batch[0].sql);
        const results = [];
        for (const stmt of batch) {
          const key = [stmt.bindings[1], stmt.bindings[2], stmt.bindings[3]].join('|');
          if (flagRows.has(key)) {
            if (orIgnore) {
              results.push({ success: true });
              continue;
            }
            const err = new Error(
              'UNIQUE constraint failed: review_flags.user_id, review_flags.date, review_flags.reason'
            );
            batchErrors.push(err);
            throw err;
          }
          flagRows.set(key, stmt.bindings);
          results.push({ success: true });
        }
        return results;
      }
      return batch.map(() => ({ success: true }));
    },
  };
  return { db, statements, batches, batchErrors, flagRows };
}

function datedReport(rows) {
  return JSON.stringify({
    type: 'daily',
    daily: rows.map((r) => ({
      date: r.date,
      inputTokens: r.totalTokens - 100,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: r.totalTokens,
      totalCost: r.totalCost ?? 1,
      modelsUsed: ['claude-sonnet-4-5'],
    })),
  });
}

test('h3: re-uploading the same anomalous report does not duplicate flags', async () => {
  const { db, statements, batchErrors, flagRows } = createDedupDatabase();
  const report = dailyReport([{ totalTokens: 11_000_000_000, totalCost: 5 }]);

  const res1 = await upload(db, report);
  assert.equal(res1.status, 200);
  assert.equal((await res1.json()).ok, true);
  const res2 = await upload(db, report);
  assert.equal(res2.status, 200);
  assert.equal((await res2.json()).ok, true);

  assert.equal(flagRows.size, 1);
  assert.equal(batchErrors.length, 0);
  const flagStmt = statements.find(
    ({ sql }) => /INSERT/.test(sql) && /review_flags/.test(sql)
  );
  assert.ok(flagStmt, 'expected a review_flags insert statement');
  assert.match(flagStmt.sql, /INSERT OR IGNORE INTO review_flags/);
});

test('h3: distinct dates and reasons still insert separately', async () => {
  const { db, batchErrors, flagRows } = createDedupDatabase();
  const res = await upload(
    db,
    datedReport([
      { date: '2026-09-10', totalTokens: 11_000_000_000, totalCost: 5 },
      { date: '2026-09-11', totalTokens: 150_000_000, totalCost: 15000 },
    ])
  );
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(batchErrors.length, 0);
  assert.equal(flagRows.size, 2);
  assert.ok(flagRows.has('user-1|2026-09-10|tokens_absolute'));
  assert.ok(flagRows.has('user-1|2026-09-11|cost_absolute'));
});

test('h3: same date with different reasons still inserts separately', async () => {
  const { db, batchErrors, flagRows } = createDedupDatabase();
  const res = await upload(db, dailyReport([
    { totalTokens: 11_000_000_000, totalCost: 5 },
    { totalTokens: 150_000_000, totalCost: 15000 },
  ]));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(batchErrors.length, 0);
  assert.equal(flagRows.size, 2);
  assert.ok(flagRows.has('user-1|2026-09-10|tokens_absolute'));
  assert.ok(flagRows.has('user-1|2026-09-10|cost_absolute'));
});

// H2: the median tripwire must sample history BEFORE the upsert commits,
// otherwise a stuffed upload sets its own median and the 20x check never
// fires. Stateful mock: the median SELECT reads the live usage store, and
// the daily_usage batch max-merges into it (D1-faithful ordering probe).
function createStatefulUploadDatabase({ historyTokens = [] } = {}) {
  const statements = [];
  const batches = [];
  const events = [];
  const usageByDate = new Map();
  historyTokens.forEach((total_tokens, i) => {
    usageByDate.set(`2026-07-${String(i + 1).padStart(2, '0')}`, total_tokens);
  });
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
            events.push('median-select');
            const rows = [...usageByDate.values()]
              .filter((n) => n > 0)
              .sort((a, b) => a - b)
              .map((total_tokens) => ({ total_tokens }));
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
      if (batch.length > 0 && /INSERT INTO daily_usage/.test(batch[0].sql)) {
        events.push('usage-batch');
        for (const bound of batch) {
          const date = bound.bindings[3];
          const total = Number(bound.bindings[10]) || 0;
          usageByDate.set(date, Math.max(usageByDate.get(date) || 0, total));
        }
      } else if (batch.length > 0 && /INSERT (OR IGNORE )?INTO review_flags/.test(batch[0].sql)) {
        events.push('flag-batch');
      }
      return batch.map(() => ({ success: true }));
    },
  };
  return { db, statements, batches, events, usageByDate };
}

function datedDailyReport(entries) {
  return JSON.stringify({
    type: 'daily',
    daily: entries.map((e, i) => ({
      date: e.date ?? `2026-09-${String(i + 1).padStart(2, '0')}`,
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

test('H2: median tripwire samples history before the upsert commits', async () => {
  const { db, batches, events } = createStatefulUploadDatabase({
    historyTokens: Array(7).fill(100_000),
  });
  const entries = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    totalTokens: 9_000_000_000,
    totalCost: 9000,
  }));
  const res = await upload(db, datedDailyReport(entries));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  // Median SELECT must run before the daily_usage batch commits.
  assert.deepEqual(
    events.filter((e) => e !== 'flag-batch'),
    ['median-select', 'usage-batch']
  );
  const flags = flagBatch(batches);
  assert.ok(flags, 'expected a review_flags batch');
  // 9B tokens / $9k sit below both absolute tripwires, so every flag is median-relative.
  assert.ok(flags.length > 0);
  assert.ok(flags.every((f) => f.bindings[3] === 'tokens_vs_median'));
  const detail = JSON.parse(flags[0].bindings[4]);
  assert.equal(detail.median_30d, 100000);
});

test('H2: many high rows in one upload cannot stuff their own median', async () => {
  const { db, batches } = createStatefulUploadDatabase({
    historyTokens: Array(7).fill(100_000),
  });
  const entries = Array.from({ length: 20 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, '0')}`,
    totalTokens: 100_000_000,
    totalCost: 100,
  }));
  const res = await upload(db, datedDailyReport(entries));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  const flags = flagBatch(batches);
  assert.ok(flags, 'expected a review_flags batch despite the stuffed-median attempt');
  assert.equal(flags.length, 20);
  assert.ok(flags.every((f) => f.bindings[3] === 'tokens_vs_median'));
  const detail = JSON.parse(flags[0].bindings[4]);
  assert.equal(detail.median_30d, 100000);
});

// H4 caps: a hostile report must not fan out into an unbounded daily_usage
// batch or flood the review queue. Helpers build multi-row reports with
// distinct past dates (past so the parser's today+1 future-date rejection
// never fires).

function h4PastDate(offsetDays) {
  return new Date(Date.UTC(2016, 0, 1) + offsetDays * 86400000).toISOString().slice(0, 10);
}

function h4DailyReport(count, { totalTokens = 430, totalCost = 0.01 } = {}) {
  return JSON.stringify({
    type: 'daily',
    daily: Array.from({ length: count }, (_, i) => ({
      date: h4PastDate(i),
      inputTokens: totalTokens - 100,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens,
      totalCost,
      modelsUsed: ['claude-sonnet-4-5'],
    })),
  });
}

test('h4: 3661-row report is rejected with 400', async () => {
  const { db, batches } = createUploadDatabase();
  const res = await upload(db, h4DailyReport(3661));
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /Too many entries/);
  assert.equal(batches.length, 0); // rejected before any D1 batch ran
});

test('h4: exactly 3660 rows are accepted', async () => {
  const { db } = createUploadDatabase();
  const res = await upload(db, h4DailyReport(3660));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.entries, 3660);
});

test('h4: many-anomaly report yields a bounded flag batch', async () => {
  const { db, batches } = createUploadDatabase();
  // 100 distinct-date rows, each tripping tokens_absolute. $5 stays far
  // below the parser's $100/M cap at 11B tokens, so every row is valid.
  const res = await upload(db, h4DailyReport(100, { totalTokens: 11_000_000_000, totalCost: 5 }));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  const flags = flagBatch(batches);
  assert.ok(flags, 'expected a review_flags batch');
  assert.equal(flags.length, 20);
});

test('h4: repeated (date, reason) flags dedupe to one row', async () => {
  const { db, batches } = createUploadDatabase();
  // dailyReport() reuses one date for every row: 5 identical anomalous rows
  // collapse to a single (date, reason) flag.
  const rows = Array.from({ length: 5 }, () => ({ totalTokens: 11_000_000_000, totalCost: 5 }));
  const res = await upload(db, dailyReport(rows));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  const flags = flagBatch(batches);
  assert.ok(flags, 'expected a review_flags batch');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].bindings[3], 'tokens_absolute');
});

// H5: a failing median SELECT must not discard queued absolute flags.
function createMedianFailingDatabase() {
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
          if (/ORDER BY total_tokens/.test(sql)) throw new Error('median unavailable');
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

test('median SELECT failure still inserts the absolute flag', async () => {
  const { db, batches } = createMedianFailingDatabase();
  const res = await upload(db, dailyReport([{ totalTokens: 11_000_000_000, totalCost: 5 }]));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  const flags = flagBatch(batches);
  assert.ok(flags, 'expected a review_flags batch despite median failure');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].bindings[3], 'tokens_absolute');
  assert.match(flags[0].bindings[4], /11000000000/);
});

test('median SELECT failure with normal rows inserts no flags', async () => {
  const { db, batches } = createMedianFailingDatabase();
  const res = await upload(db, dailyReport([{ totalTokens: 2_000_000, totalCost: 50 }]));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(flagBatch(batches), null);
  assert.equal(batches.length, 1);
});

// H7: a dead flag queue must be observable, not silent.
test('H7: flagging failure warns observably but still returns 200', async () => {
  const batches = [];
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warns.push(args.map(String).join(' ')); };
  try {
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
    const res = await upload(db, dailyReport([{ totalTokens: 11_000_000_000, totalCost: 5 }]));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(batches.length, 1); // only the daily_usage upsert ran
    assert.equal(warns.length, 1);
    assert.match(warns[0], /review-flags/);
    assert.match(warns[0], /non-fatal/);
  } finally {
    console.warn = origWarn;
  }
});
