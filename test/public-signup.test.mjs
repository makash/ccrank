import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-public-signup-'));
let auth;
let app;
let html;

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
  [auth, app, html] = await Promise.all([
    loadBundle('src/auth.ts', 'auth'),
    loadBundle('src/index.ts', 'app'),
    loadBundle('src/html.ts', 'html'),
  ]);
});

after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

function createDatabase(existingUser = null) {
  const statements = [];

  return {
    statements,
    prepare(sql) {
      const statement = {
        sql,
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
        async first() {
          return existingUser;
        },
        async run() {
          return { success: true };
        },
      };
      statements.push(statement);
      return statement;
    },
  };
}

test('creates a new Google user without requiring an invite code', async () => {
  const db = createDatabase();
  const googleUser = {
    id: 'google-user-123',
    email: 'new-user@example.com',
    verified_email: true,
    name: 'New User',
    picture: 'https://example.com/avatar.png',
  };

  const user = await auth.findOrCreateGoogleUser(db, googleUser, 'admin@example.com');

  assert.equal(user.email, googleUser.email);
  assert.match(user.id, /^[a-f0-9]{32}$/);
  assert.equal(db.statements.length, 2);
  assert.match(db.statements[0].sql, /WHERE google_id = \?/);
  assert.match(db.statements[1].sql, /INSERT INTO users/);
  assert.deepEqual(db.statements[1].bindings.slice(1, 5), [
    googleUser.id,
    googleUser.email,
    googleUser.name,
    googleUser.picture,
  ]);
});

test('returns an existing Google user without creating a duplicate', async () => {
  const existingUser = { id: 'existing-user', email: 'member@example.com' };
  const db = createDatabase(existingUser);

  const user = await auth.findOrCreateGoogleUser(
    db,
    {
      id: 'google-user-456',
      email: existingUser.email,
      verified_email: true,
      name: 'Existing User',
      picture: '',
    },
    'admin@example.com'
  );

  assert.equal(user, existingUser);
  assert.equal(db.statements.length, 1);
});

test('renders one public Google signup entry point without an invite form', () => {
  const page = html.loginPage();

  assert.match(page, /Sign in or join/);
  assert.match(page, /New accounts are created automatically/);
  assert.doesNotMatch(page, /invite code/i);
  assert.equal(page.match(/\/auth\/google/g)?.length, 1);
});

test('completes the OAuth callback for a new user without querying invites', async () => {
  const db = createDatabase();
  const env = {
    DB: db,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-session-secret',
    ADMIN_EMAIL: 'admin@example.com',
    SIRV_CLIENT_ID: '',
    SIRV_CLIENT_SECRET: '',
  };

  const startResponse = await app.default.request(
    'https://ccrank.dev/auth/google',
    {},
    env
  );
  const authorizeUrl = new URL(startResponse.headers.get('location'));
  const state = authorizeUrl.searchParams.get('state');
  const stateCookie = startResponse.headers.get('set-cookie').split(';', 1)[0];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'test-access-token' });
    }

    if (String(url).includes('googleapis.com/oauth2/v2/userinfo')) {
      return Response.json({
        id: 'google-user-789',
        email: 'public-user@example.com',
        verified_email: true,
        name: 'Public User',
        picture: '',
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const callbackResponse = await app.default.request(
      `https://ccrank.dev/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: stateCookie } },
      env
    );

    assert.equal(callbackResponse.status, 302);
    assert.equal(callbackResponse.headers.get('location'), '/');
    assert.match(callbackResponse.headers.get('set-cookie'), /session=/);
    assert.equal(
      db.statements.some((statement) => /invite_codes/.test(statement.sql)),
      false
    );
    assert.equal(
      db.statements.some((statement) => /INSERT INTO users/.test(statement.sql)),
      true
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects an unverified Google email before account creation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    id: 'google-user-unverified',
    email: 'unverified@example.com',
    verified_email: false,
    name: 'Unverified User',
    picture: '',
  });

  try {
    await assert.rejects(
      auth.getGoogleUser('test-access-token'),
      /verified email/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
