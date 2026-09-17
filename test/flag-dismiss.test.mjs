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
