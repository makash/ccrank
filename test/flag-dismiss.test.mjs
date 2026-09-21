// Dismiss-queue drain: the flag queue only grows, so admins get the
// lowest-rung drain — dismiss flips a flag to 'dismissed' and the queue
// shows open-only rows. Dismiss is review-only: it never touches
// daily_usage (the never-lower invariant is untouched by this slice).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-flag-dismiss-'));
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

const SESSION_SECRET = 'test-flag-dismiss-secret';

const baseUser = {
  google_id: 'google-1',
  email: 'user@example.com',
  display_name: 'Test User',
  avatar_url: null,
  invites_remaining: 0,
  sharing_enabled: 1,
  git_sharing_enabled: 1,
  share_slug: 'test-user',
  fav_tools: '[]',
};

const adminUser = { ...baseUser, id: 'admin-1', email: 'admin@example.com', display_name: 'Admin', is_admin: 1 };
const normalUser = { ...baseUser, id: 'user-1', is_admin: 0 };

// Stateful review_flags store. openFlags() mirrors the queue's
// COALESCE(status, 'open') = 'open' predicate: anything not explicitly
// 'dismissed' (including rows with no status key, i.e. pre-migration
// rows) reads as open.
function createFlagsDatabase({ viewer, flags }) {
  const statements = [];
  const store = flags.map((f) => ({ ...f }));
  const openFlags = () => store.filter((f) => f.status !== 'dismissed');
  const db = {
    prepare(sql) {
      const firstFor = async (bindings) => {
        if (/FROM review_flags/.test(sql) && /COUNT\(\*\)/.test(sql)) return { cnt: openFlags().length };
        if (/FROM review_flags/.test(sql)) {
          const row = store.find((f) => f.id === bindings[0]);
          return row ? { id: row.id } : null;
        }
        if (/FROM users/.test(sql) && bindings.length > 0) {
          return bindings[0] === viewer?.id ? viewer : null;
        }
        if (/COUNT\(\*\)/.test(sql)) return { cnt: 0 };
        return null;
      };
      const allFor = async () => {
        if (/FROM review_flags/.test(sql)) {
          return {
            results: openFlags().map((f) => ({
              id: f.id,
              user_id: f.user_id,
              date: f.date,
              reason: f.reason,
              detail: f.detail ?? null,
              created_at: f.created_at,
              display_name: f.display_name ?? null,
              ...(f.status === undefined ? {} : { status: f.status }),
            })),
          };
        }
        return { results: [] };
      };
      const runFor = async (bindings) => {
        if (/UPDATE review_flags/.test(sql)) {
          const row = store.find((f) => f.id === bindings[0]);
          if (row) row.status = 'dismissed';
          return { success: true, meta: { changes: row ? 1 : 0 } };
        }
        return { success: true };
      };
      const statement = {
        sql,
        bindings: [],
        first: () => firstFor([]),
        all: () => allFor([]),
        run: () => runFor([]),
        bind(...bindings) {
          const bound = {
            sql,
            bindings,
            first: () => firstFor(bindings),
            all: () => allFor(bindings),
            run: () => runFor(bindings),
          };
          statements.push(bound);
          return bound;
        },
      };
      statements.push(statement);
      return statement;
    },
  };
  return { db, statements, store };
}

function openFlag(overrides = {}) {
  return {
    id: 'f1',
    user_id: 'user-1',
    date: '2026-09-10',
    reason: 'tokens_absolute',
    detail: '{"total_tokens":11000000000}',
    created_at: '2026-09-10 12:00:00',
    display_name: 'Test User',
    status: 'open',
    ...overrides,
  };
}

async function sessionCookie(user) {
  const token = await auth.createSessionToken({ userId: user.id, email: user.email }, SESSION_SECRET);
  return `session=${token}`;
}

async function dismiss(db, id, cookie) {
  return app.default.request(
    `https://ccrank.dev/api/admin/flags/${id}/dismiss`,
    { method: 'POST', headers: cookie ? { Cookie: cookie } : {} },
    { DB: db, SESSION_SECRET }
  );
}

async function getAdmin(db, cookie) {
  return app.default.request(
    'https://ccrank.dev/admin',
    { headers: { Cookie: cookie } },
    { DB: db, SESSION_SECRET }
  );
}

test('flag-dismiss: admin dismiss flips status to dismissed and returns ok', async () => {
  const { db, statements, store } = createFlagsDatabase({ viewer: adminUser, flags: [openFlag()] });
  const res = await dismiss(db, 'f1', await sessionCookie(adminUser));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(store.find((f) => f.id === 'f1').status, 'dismissed');
  const update = statements.find(({ sql, bindings }) => /UPDATE review_flags/.test(sql) && bindings.length > 0);
  assert.ok(update, 'expected a review_flags UPDATE');
  assert.match(update.sql, /status = 'dismissed'/);
  assert.deepEqual(update.bindings, ['f1']);
  // Review-only: dismiss must never touch usage history.
  assert.ok(statements.every(({ sql }) => !/daily_usage/.test(sql)), 'dismiss touched daily_usage');
});

test('flag-dismiss: dismissed flags leave the admin queue and count', async () => {
  const { db, statements } = createFlagsDatabase({
    viewer: adminUser,
    flags: [openFlag(), openFlag({ id: 'f2', reason: 'cost_absolute', status: 'dismissed' })],
  });
  const res = await getAdmin(db, await sessionCookie(adminUser));

  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /tokens_absolute/);
  assert.doesNotMatch(page, /cost_absolute/);
  assert.match(page, /\/api\/admin\/flags\/f1\/dismiss/);
  const queue = statements.find(({ sql }) => /FROM review_flags/.test(sql) && /ORDER BY/.test(sql));
  assert.ok(queue, 'expected a review queue SELECT');
  assert.match(queue.sql, /COALESCE\(rf\.status, 'open'\) = 'open'/);
  const count = statements.find(({ sql }) => /FROM review_flags/.test(sql) && /COUNT\(\*\)/.test(sql));
  assert.ok(count, 'expected a review count SELECT');
  assert.match(count.sql, /COALESCE\(status, 'open'\) = 'open'/);
});

test('flag-dismiss: non-admin dismiss returns 401 and leaves the flag open', async () => {
  const { db, statements, store } = createFlagsDatabase({ viewer: normalUser, flags: [openFlag()] });
  const res = await dismiss(db, 'f1', await sessionCookie(normalUser));

  assert.equal(res.status, 401);
  assert.equal((await res.json()).ok, false);
  assert.equal(store.find((f) => f.id === 'f1').status, 'open');
  assert.ok(statements.every(({ sql }) => !/UPDATE review_flags/.test(sql)));
});

test('flag-dismiss: unauthenticated dismiss returns 401', async () => {
  const { db, store } = createFlagsDatabase({ viewer: null, flags: [openFlag()] });
  const res = await dismiss(db, 'f1', null);

  assert.equal(res.status, 401);
  assert.equal((await res.json()).ok, false);
  assert.equal(store.find((f) => f.id === 'f1').status, 'open');
});

test('flag-dismiss: unknown flag id returns 404', async () => {
  const { db, statements } = createFlagsDatabase({ viewer: adminUser, flags: [openFlag()] });
  const res = await dismiss(db, 'nope', await sessionCookie(adminUser));
  const body = await res.json();

  assert.equal(res.status, 404);
  assert.equal(body.ok, false);
  assert.ok(statements.every(({ sql }) => !/UPDATE review_flags/.test(sql)));
});

test('flag-dismiss: rows without status read as open (backward compat)', async () => {
  const legacy = openFlag();
  delete legacy.status;
  const { db } = createFlagsDatabase({ viewer: adminUser, flags: [legacy] });
  const res = await getAdmin(db, await sessionCookie(adminUser));

  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /tokens_absolute/);
  assert.match(page, /\/api\/admin\/flags\/f1\/dismiss/);
  // The template renders status-less rows without branching on status.
  const direct = html.adminPage(
    adminUser,
    { total_users: 1, total_uploads: 1, total_invites: 0, total_flags: 1 },
    [],
    [
      {
        id: 'f9',
        user_id: 'user-1',
        date: '2026-09-10',
        reason: 'cost_absolute',
        detail: null,
        created_at: '2026-09-10 12:00:00',
        display_name: null,
      },
    ]
  );
  assert.match(direct, /cost_absolute/);
  assert.match(direct, /<form method="POST" action="\/api\/admin\/flags\/f9\/dismiss">/);
});

// ─── B2 end-to-end: suspicious upload → flag row → review UI → dismiss ───
// One stateful store behind all four hops: the upload authenticates as the
// normal user via Bearer token, the flag batch lands in the same store the
// admin queue reads, and dismiss flips the same row. Merge/ignore semantics
// are SQL-driven (see never-lower.test.mjs): usage max-merges per column IFF
// the statement text carries the MAX template, and flag inserts dedupe IFF
// the statement text is INSERT OR IGNORE — so a SQL regression fails here.
const E2E_NUMERIC_COLS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'total_tokens',
  'cost_usd',
];
const E2E_BIND_POS = {
  input_tokens: 6,
  output_tokens: 7,
  cache_creation_tokens: 8,
  cache_read_tokens: 9,
  total_tokens: 10,
  cost_usd: 11,
};

function createLifecycleDatabase() {
  const users = { 'admin-1': adminUser, 'user-1': normalUser };
  const usage = new Map(); // user|date|source|platform -> numerics row
  const flags = [];
  const db = {
    prepare(sql) {
      const firstFor = async (bindings) => {
        if (/FROM api_tokens/.test(sql)) return { id: 'token-1', user_id: 'user-1' };
        if (/FROM users/.test(sql)) return users[bindings[0]] ?? null;
        if (/FROM review_flags/.test(sql) && /COUNT\(\*\)/.test(sql)) {
          return { cnt: flags.filter((f) => f.status !== 'dismissed').length };
        }
        if (/FROM review_flags/.test(sql)) {
          const row = flags.find((f) => f.id === bindings[0]);
          return row ? { id: row.id } : null;
        }
        if (/COUNT\(\*\)/.test(sql)) return { cnt: 0 };
        return null;
      };
      const allFor = async (bindings) => {
        if (/ORDER BY total_tokens/.test(sql)) {
          return {
            results: [...usage.values()]
              .filter((row) => row.total_tokens > 0)
              .sort((a, b) => a.total_tokens - b.total_tokens)
              .map((row) => ({ date: row.date, total_tokens: row.total_tokens })),
          };
        }
        if (/SUM\(total_tokens\)/.test(sql) && /GROUP BY date/.test(sql)) {
          const dates = bindings.slice(1);
          const sums = new Map();
          for (const row of usage.values()) {
            if (dates.includes(row.date)) {
              sums.set(row.date, (sums.get(row.date) || 0) + row.total_tokens);
            }
          }
          return { results: [...sums.entries()].map(([date, day_total]) => ({ date, day_total })) };
        }
        if (/FROM review_flags/.test(sql)) {
          return {
            results: flags
              .filter((f) => f.status !== 'dismissed')
              .map((f) => ({ ...f, display_name: users[f.user_id]?.display_name ?? null })),
          };
        }
        return { results: [] };
      };
      const runFor = async (bindings) => {
        if (/UPDATE review_flags/.test(sql)) {
          const row = flags.find((f) => f.id === bindings[0]);
          if (row) row.status = 'dismissed';
          return { success: true, meta: { changes: row ? 1 : 0 } };
        }
        return { success: true };
      };
      const statement = {
        sql,
        bindings: [],
        first: () => firstFor([]),
        all: () => allFor([]),
        run: () => runFor([]),
        bind(...bindings) {
          return {
            sql,
            bindings,
            first: () => firstFor(bindings),
            all: () => allFor(bindings),
            run: () => runFor(bindings),
          };
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
          for (const column of E2E_NUMERIC_COLS) {
            const incoming = Number(b[E2E_BIND_POS[column]]) || 0;
            if (stmt.sql.includes(`MAX(excluded.${column}, daily_usage.${column})`)) {
              next[column] = Math.max(prev[column], incoming);
            } else {
              next[column] = incoming;
            }
          }
          usage.set(key, next);
        } else if (/INTO review_flags/.test(stmt.sql)) {
          const [id, userId, date, reason, detail] = stmt.bindings;
          const orIgnore = /INSERT OR IGNORE/.test(stmt.sql);
          const existing = flags.find(
            (f) => f.user_id === userId && f.date === date && f.reason === reason
          );
          if (existing) {
            if (!orIgnore) throw new Error('UNIQUE constraint failed: review_flags.user_id, review_flags.date, review_flags.reason');
          } else {
            flags.push({ id, user_id: userId, date, reason, detail, created_at: '2026-09-10 12:00:00', status: 'open' });
          }
        }
      }
      return batch.map(() => ({ success: true }));
    },
  };
  return { db, usage, flags };
}

async function lifecycleUpload(db, reportJson, extraBody = {}) {
  return app.default.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer [REDACTED]', 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: reportJson, source: 'secrig', cli_version: '1.7.1', ...extraBody }),
    },
    { DB: db }
  );
}

test('flag-dismiss: re-trip of a dismissed (date,reason) stays dismissed (mute-forever, pinned)', async () => {
  // Mechanism pin: the upload flag insert is INSERT OR IGNORE on
  // (user_id,date,reason), so a re-trip after dismiss inserts nothing and
  // the row stays dismissed with its original detail. If re-open-on-retrip
  // is ever implemented, update this test deliberately.
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /INSERT OR IGNORE INTO review_flags/);
  assert.doesNotMatch(src, /DO UPDATE SET status/);

  // Row-level consequence: a dismissed row leaves the open queue and dismiss
  // is idempotent (re-dismiss keeps original detail).
  const { db, store } = createFlagsDatabase({ viewer: adminUser, flags: [openFlag()] });
  const cookie = await sessionCookie(adminUser);
  const detail = store.find((f) => f.id === 'f1').detail;
  assert.equal((await (await dismiss(db, 'f1', cookie)).json()).ok, true);
  assert.equal((await (await dismiss(db, 'f1', cookie)).json()).ok, true);
  const row = store.find((f) => f.id === 'f1');
  assert.equal(row.status, 'dismissed');
  assert.equal(row.detail, detail);
  const res = await getAdmin(db, cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /tokens_absolute/);
});

test('e2e: suspicious upload -> flag row -> review UI -> dismiss -> queue drains', async () => {
  const { db, usage, flags } = createLifecycleDatabase();
  const adminCookie = await sessionCookie(adminUser);
  const report = JSON.stringify({
    type: 'daily',
    daily: [{
      date: '2026-09-10',
      inputTokens: 11_000_000_000 - 100,
      outputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 11_000_000_000,
      totalCost: 5,
      modelsUsed: ['claude-sonnet-4-5'],
    }],
  });

  // 1. Suspicious upload is accepted AND persists: review-only never drops data.
  // The 11B row trips BOTH the per-row absolute check and the post-upsert
  // daily aggregate (stored day total 11B > 10B).
  const up = await lifecycleUpload(db, report);
  assert.equal(up.status, 200);
  assert.equal((await up.json()).ok, true);
  const stored = usage.get('user-1|2026-09-10|secrig|claude');
  assert.ok(stored, 'expected the uploaded row in the usage store');
  assert.equal(stored.total_tokens, 11_000_000_000);
  assert.equal(flags.length, 2);
  assert.deepEqual(flags.map((f) => f.reason).sort(), ['tokens_absolute', 'tokens_daily_total']);
  assert.ok(flags.every((f) => f.status === 'open'));
  const byReason = Object.fromEntries(flags.map((f) => [f.reason, f]));
  assert.equal(JSON.parse(byReason.tokens_daily_total.detail).day_total_tokens, 11_000_000_000);
  const details = Object.fromEntries(flags.map((f) => [f.reason, f.detail]));

  // 2. The review UI surfaces both flags, each with a working dismiss action.
  const adminPage = await getAdmin(db, adminCookie);
  assert.equal(adminPage.status, 200);
  const page = await adminPage.text();
  assert.match(page, /tokens_absolute/);
  assert.match(page, /tokens_daily_total/);
  assert.match(page, /Test User/);
  for (const f of flags) {
    assert.ok(page.includes(`/api/admin/flags/${f.id}/dismiss`), `review UI must link the dismiss action for ${f.reason}`);
  }

  // 3. Dismissing each flips its row and the queue drains.
  for (const f of flags) {
    const dis = await dismiss(db, f.id, adminCookie);
    assert.equal(dis.status, 200);
    assert.equal((await dis.json()).ok, true);
  }
  assert.ok(flags.every((f) => f.status === 'dismissed'));
  const drained = await getAdmin(db, adminCookie);
  assert.equal(drained.status, 200);
  const drainedPage = await drained.text();
  assert.doesNotMatch(drainedPage, /tokens_absolute/);
  assert.doesNotMatch(drainedPage, /tokens_daily_total/);
  assert.match(drainedPage, /No anomalies flagged/);

  // 4. Re-upload re-trips but both stay dismissed with original detail
  // (mute-forever via INSERT OR IGNORE); the usage peak is untouched
  // (idempotent max-merge).
  const up2 = await lifecycleUpload(db, report);
  assert.equal(up2.status, 200);
  assert.equal((await up2.json()).ok, true);
  assert.equal(flags.length, 2);
  assert.ok(flags.every((f) => f.status === 'dismissed'));
  for (const f of flags) {
    assert.equal(f.detail, details[f.reason], `${f.reason} detail changed after re-trip`);
  }
  assert.equal(usage.get('user-1|2026-09-10|secrig|claude').total_tokens, 11_000_000_000);
});
