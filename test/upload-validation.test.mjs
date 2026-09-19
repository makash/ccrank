import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-upload-validation-'));
let app;
let parser;

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
  [app, parser] = await Promise.all([
    loadBundle('src/index.ts', 'app'),
    loadBundle('src/parser.ts', 'parser'),
  ]);
});

after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

function utcDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dailyEntry(overrides = {}) {
  return {
    date: '2026-08-12',
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 10,
    cacheReadTokens: 300,
    totalTokens: 430,
    totalCost: 0.01,
    modelsUsed: ['claude-opus-4-6'],
    ...overrides,
  };
}

function sessionEntry(overrides = {}) {
  return {
    sessionId: 'session-1',
    lastActivity: '2026-08-12',
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 10,
    cacheReadTokens: 300,
    totalTokens: 430,
    totalCost: 0.01,
    modelsUsed: ['claude-opus-4-6'],
    ...overrides,
  };
}

test('rejects negative token fields and negative cost', () => {
  for (const field of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens']) {
    assert.throws(
      () => parser.parseReport(JSON.stringify({ type: 'daily', daily: [dailyEntry({ [field]: -5 })] })),
      /negative/,
      `${field}=-5 must be rejected`,
    );
  }
  assert.throws(
    () => parser.parseReport(JSON.stringify({ type: 'daily', daily: [dailyEntry({ totalCost: -0.5 })] })),
    /costUsd/,
    'negative cost must be rejected',
  );
});

test('non-finite literals cannot arrive via the JSON transport', () => {
  // JSON has no NaN/Infinity literals, so the parser's Number.isFinite guard
  // is defense-in-depth unreachable through the transport; the transport
  // itself rejects such payloads as invalid.
  assert.throws(
    () => parser.parseReport('{"type":"daily","daily":[{"date":"2026-08-12","inputTokens":Infinity}]}'),
    /Invalid JSON/,
  );
  assert.throws(
    () => parser.parseReport('{"type":"daily","daily":[{"date":"2026-08-12","totalCost":NaN}]}'),
    /Invalid JSON/,
  );
});

test('rejects totalTokens inconsistent with the component sum beyond tolerance', () => {
  // 500 vs component sum 430: diff 70 >> tolerance max(1, 0.43) = 1.
  assert.throws(
    () => parser.parseReport(JSON.stringify({ type: 'daily', daily: [dailyEntry({ totalTokens: 500 })] })),
    /totalTokens/,
  );
  // A diff of exactly 1 is within tolerance and stays accepted.
  const rounding = parser.parseReport(JSON.stringify({ type: 'daily', daily: [dailyEntry({ totalTokens: 431 })] }));
  assert.equal(rounding.entries[0].totalTokens, 431);
  // Relative tolerance: 0.1% of 1M = 1000, so a 500 diff is fine but 1500 is not.
  const base = { inputTokens: 999500, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 1 };
  const close = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [dailyEntry({ ...base, totalTokens: 1_000_000 })],
  }));
  assert.equal(close.entries[0].totalTokens, 1_000_000);
  assert.throws(
    () => parser.parseReport(JSON.stringify({
      type: 'daily',
      daily: [dailyEntry({ ...base, totalTokens: 1_001_000 })],
    })),
    /totalTokens/,
  );
});

test('tolerance edge: diff of exactly 1000 accepted, 1001 rejected at 1M total', () => {
  const edge = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [dailyEntry({
      inputTokens: 999000,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 1_000_000,
      totalCost: 1,
    })],
  }));
  assert.equal(edge.entries[0].totalTokens, 1_000_000);
  assert.throws(
    () => parser.parseReport(JSON.stringify({
      type: 'daily',
      daily: [dailyEntry({
        inputTokens: 998999,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 1_000_000,
        totalCost: 1,
      })],
    })),
    /totalTokens/,
  );
});

test('zero-token rows with nonzero cost are accepted (per-request billing)', () => {
  const free = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [dailyEntry({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    })],
  }));
  assert.equal(free.entries[0].totalTokens, 0);
  // Cursor bills per request: zero-token/nonzero-cost day rows are a
  // supported shape (cursor_usage.go keeps them), so the parser accepts
  // them; implausible $/M is a review_flags signal, never a reject.
  const billed = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [dailyEntry({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      totalCost: 0.01,
    })],
  }));
  assert.equal(billed.entries[0].costUsd, 0.01);
});

test('accepts rows omitting totalTokens (presence-aware consistency)', () => {
  // num() coerces the missing total to 0; consistency is only enforced
  // when the reporter actually sent a total.
  const report = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [dailyEntry({ totalTokens: undefined, totalCost: 0 })],
  }));
  assert.equal(report.entries[0].totalTokens, 0);
});

test('high cost-per-token rows are accepted at parse (flagged, not rejected)', () => {
  // 430 tokens at $10 is ~$23k/M — implausible for token pricing, routine
  // for per-request billing (Cursor: 150 tok @ $0.04 is a real row). The
  // parser accepts; cost_implausible flags it in review_flags instead.
  const pricey = parser.parseReport(JSON.stringify({ type: 'daily', daily: [dailyEntry({ totalCost: 10 })] }));
  assert.equal(pricey.entries[0].costUsd, 10);
  const cursorShaped = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [dailyEntry({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 150,
      totalCost: 0.04,
    })],
  }));
  assert.equal(cursorShaped.entries[0].costUsd, 0.04);
  // $0-cost rows with tokens (free tiers) must stay accepted.
  const free = parser.parseReport(JSON.stringify({ type: 'daily', daily: [dailyEntry({ totalCost: 0 })] }));
  assert.equal(free.entries[0].totalTokens, 430);
  assert.equal(free.entries[0].costUsd, 0);
});

test('rejects dates after today+1 day UTC', () => {
  assert.throws(
    () => parser.parseReport(JSON.stringify({ type: 'daily', daily: [dailyEntry({ date: utcDate(5) })] })),
    /Future date/,
  );
  const today = parser.parseReport(JSON.stringify({ type: 'daily', daily: [dailyEntry({ date: utcDate(0) })] }));
  assert.equal(today.entries[0].date, utcDate(0));
  // One day of grace for timezones near midnight UTC.
  const grace = parser.parseReport(JSON.stringify({ type: 'daily', daily: [dailyEntry({ date: utcDate(1) })] }));
  assert.equal(grace.entries[0].date, utcDate(1));
});

test('rejects today+2: the future-date grace is exactly one day', () => {
  assert.throws(
    () => parser.parseReport(JSON.stringify({ type: 'daily', daily: [dailyEntry({ date: utcDate(2) })] })),
    /Future date/,
  );
});

test('rejects duplicate sessionId within a session upload', () => {
  assert.throws(
    () => parser.parseReport(JSON.stringify({
      type: 'session',
      sessions: [
        sessionEntry({ sessionId: 'dup', lastActivity: '2026-08-12' }),
        sessionEntry({ sessionId: 'dup', lastActivity: '2026-08-13' }),
      ],
    })),
    /Duplicate sessionId/,
    'a repeated sessionId would be SUMmed twice',
  );

  // Distinct sessionIds aggregate by lastActivity date as before.
  const distinct = parser.parseReport(JSON.stringify({
    type: 'session',
    sessions: [
      sessionEntry({ sessionId: 'a', lastActivity: '2026-08-12' }),
      sessionEntry({ sessionId: 'b', lastActivity: '2026-08-13' }),
    ],
  }));
  assert.equal(distinct.entries.length, 2);

  // Rows without a sessionId carry no identity signal and are skipped.
  const anonymous = parser.parseReport(JSON.stringify({
    type: 'session',
    sessions: [
      sessionEntry({ sessionId: undefined, lastActivity: '2026-08-12' }),
      sessionEntry({ sessionId: undefined, lastActivity: '2026-08-12' }),
    ],
  }));
  assert.equal(anonymous.entries.length, 1);
  assert.equal(anonymous.entries[0].totalTokens, 860);
});

test('null and empty-string sessionIds are skipped, not treated as duplicates', () => {
  const report = parser.parseReport(JSON.stringify({
    type: 'session',
    sessions: [
      sessionEntry({ sessionId: null, lastActivity: '2026-08-12' }),
      sessionEntry({ sessionId: '', lastActivity: '2026-08-12' }),
    ],
  }));
  assert.equal(report.entries.length, 1);
});

test('weekly reports stay accepted', () => {
  const report = parser.parseReport(JSON.stringify({ type: 'weekly', weekly: [dailyEntry()] }));
  assert.equal(report.type, 'weekly');
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].totalTokens, 430);
});

test('upload endpoint maps validation failures to HTTP 400', async () => {
  const user = {
    id: 'user-1',
    google_id: 'google-1',
    email: 'parsetest@example.com',
    display_name: 'Parse Test',
    avatar_url: null,
    is_admin: 0,
    invites_remaining: 0,
    sharing_enabled: 1,
    git_sharing_enabled: 1,
    share_slug: 'parse-test',
    fav_tools: '[]',
  };
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
          if (sql.includes('FROM api_tokens')) return { id: 'token-1', user_id: user.id };
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

  const bad = await app.default.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer [REDACTED]' },
      body: JSON.stringify({
        json: JSON.stringify({ type: 'daily', daily: [dailyEntry({ inputTokens: -5 })] }),
        source: 'secrig',
      }),
    },
    { DB: db },
  );
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).ok, false);

  const good = await app.default.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer [REDACTED]' },
      body: JSON.stringify({
        json: JSON.stringify({ type: 'daily', daily: [dailyEntry()] }),
        source: 'secrig',
      }),
    },
    { DB: db },
  );
  assert.equal(good.status, 200);
  assert.equal((await good.json()).ok, true);
});

test('H1: session lastActivity in the future is rejected', () => {
  // lastActivity overwrites the validated date at aggregation time, so it
  // must pass the same future-date rule as daily rows.
  assert.throws(
    () => parser.parseReport(JSON.stringify({
      type: 'session',
      sessions: [sessionEntry({ date: '2026-08-12', lastActivity: utcDate(30) })],
    })),
    /Future date/,
  );
  // Past lastActivity still aggregates under its own date.
  const ok = parser.parseReport(JSON.stringify({
    type: 'session',
    sessions: [sessionEntry({ date: '2026-08-12', lastActivity: '2026-08-11' })],
  }));
  assert.equal(ok.entries[0].date, '2026-08-11');
});

test('S5a: session validation errors report the real entry index', () => {
  // Negative tokens in the SECOND row must cite index 1, not index 0.
  assert.throws(
    () => parser.parseReport(JSON.stringify({
      type: 'session',
      sessions: [
        sessionEntry({ sessionId: 'ok-1', lastActivity: '2026-08-12' }),
        sessionEntry({ sessionId: 'bad-1', lastActivity: '2026-08-12', inputTokens: -5 }),
      ],
    })),
    /index 1/,
  );
  // A bad lastActivity overwrite on the THIRD row must cite index 2 (the
  // session branch used to re-validate every row at index 0).
  assert.throws(
    () => parser.parseReport(JSON.stringify({
      type: 'session',
      sessions: [
        sessionEntry({ sessionId: 'ok-1', lastActivity: '2026-08-12' }),
        sessionEntry({ sessionId: 'ok-2', lastActivity: '2026-08-12' }),
        sessionEntry({ sessionId: 'bad-2', date: '2026-08-12', lastActivity: 'not-a-date' }),
      ],
    })),
    /index 2/,
  );
});

test('S5b: session single pass preserves summary fallback and platform detection', () => {
  // No summary key: the fallback sums the single-pass rows, same-date rows
  // still aggregate, and platform still derives from the merged models.
  const report = parser.parseReport(JSON.stringify({
    type: 'session',
    sessions: [
      sessionEntry({
        sessionId: 's1', lastActivity: '2026-08-12',
        inputTokens: 100, outputTokens: 20, cacheCreationTokens: 10,
        cacheReadTokens: 300, totalTokens: 430, totalCost: 0.01,
        modelsUsed: ['gpt-4o'],
      }),
      sessionEntry({
        sessionId: 's2', lastActivity: '2026-08-12',
        inputTokens: 200, outputTokens: 40, cacheCreationTokens: 20,
        cacheReadTokens: 600, totalTokens: 860, totalCost: 0.02,
        modelsUsed: ['claude-opus-4-6'],
      }),
    ],
  }));
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].date, '2026-08-12');
  assert.equal(report.entries[0].totalTokens, 1290);
  assert.equal(report.summary.totalTokens, 1290);
  assert.equal(report.summary.totalInputTokens, 300);
  // gpt-4o sorts first, so the merged row (and report) detect as codex.
  assert.equal(report.entries[0].platform, 'codex');
  assert.equal(report.platform, 'codex');
  assert.deepEqual([...report.entries[0].modelsUsed].sort(), ['claude-opus-4-6', 'gpt-4o']);
  // An explicit summary still wins over the computed fallback.
  const withSummary = parser.parseReport(JSON.stringify({
    type: 'session',
    summary: {
      totalInputTokens: 1, totalOutputTokens: 2, totalCacheCreationTokens: 3,
      totalCacheReadTokens: 4, totalTokens: 10, totalCost: 0.5,
    },
    sessions: [sessionEntry({ sessionId: 's1', lastActivity: '2026-08-12' })],
  }));
  assert.equal(withSummary.summary.totalTokens, 10);
});

test('S17 pin: mixed valid+invalid session upload fails closed with zero daily_usage writes', async () => {
  // PIN of current fail-closed behavior: one bad row rejects the WHOLE
  // upload (400) and no daily_usage statement may execute. Do NOT implement
  // skip-and-200 here; that is a separate product decision.
  const user = {
    id: 'user-1',
    google_id: 'google-1',
    email: 'parsetest@example.com',
    display_name: 'Parse Test',
    avatar_url: null,
    is_admin: 0,
    invites_remaining: 0,
    sharing_enabled: 1,
    git_sharing_enabled: 1,
    share_slug: 'parse-test',
    fav_tools: '[]',
  };
  const seenSql = [];
  let batchCalls = 0;
  const db = {
    prepare(sql) {
      seenSql.push(sql);
      const statement = {
        sql,
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
        async first() {
          if (sql.includes('FROM api_tokens')) return { id: 'token-1', user_id: user.id };
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
      batchCalls += 1;
      return statements.map(() => ({ success: true }));
    },
  };

  const res = await app.default.request(
    'https://ccrank.dev/api/upload',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer [REDACTED]' },
      body: JSON.stringify({
        json: JSON.stringify({
          type: 'session',
          sessions: [
            sessionEntry({ sessionId: 'good', lastActivity: '2026-08-12' }),
            sessionEntry({ sessionId: 'bad', lastActivity: '2026-08-12', inputTokens: -5 }),
          ],
        }),
        source: 'secrig',
      }),
    },
    { DB: db },
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
  assert.equal(seenSql.filter((sql) => sql.includes('daily_usage')).length, 0);
  assert.equal(batchCalls, 0);
});

test('S2: total-only rows 400 against the zeroed component sum (pinned)', () => {
  // Documented choice: a total no components corroborate cannot ground
  // max-merged history, and skipping the check on omitted components would
  // let any row dodge it by omission. Re-upload with full rows recovers.
  assert.throws(
    () => parser.parseReport(JSON.stringify({
      type: 'daily',
      daily: [{ date: '2026-08-12', totalTokens: 430, totalCost: 0.01 }],
    })),
    /totalTokens/,
  );
  // The $0 variant 400s too: it is the consistency check rejecting, not the cost cap.
  assert.throws(
    () => parser.parseReport(JSON.stringify({
      type: 'daily',
      daily: [{ date: '2026-08-12', totalTokens: 430, totalCost: 0 }],
    })),
    /totalTokens/,
  );
});

test('S3: omitted total with nonzero cost is accepted (no ratio reject)', () => {
  // A missing total coerces to 0 tokens; with no cost-per-token reject,
  // nonzero cost is accepted (implausible $/M is a review_flags signal).
  const report = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [dailyEntry({ totalTokens: undefined, totalCost: 0.01 })],
  }));
  assert.equal(report.entries[0].totalTokens, 0);
  assert.equal(report.entries[0].costUsd, 0.01);
});

test('S3: omitted total with $0 cost persists total 0 (pinned, not defaulted)', () => {
  // Defaulting a missing total to the component sum would break the
  // 'accepts rows omitting totalTokens' pin (total 0); pin as-is instead.
  const report = parser.parseReport(JSON.stringify({
    type: 'daily',
    daily: [dailyEntry({
      inputTokens: 500_000,
      outputTokens: 500_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: undefined,
      totalCost: 0,
    })],
  }));
  assert.equal(report.entries[0].totalTokens, 0);
  assert.equal(report.entries[0].inputTokens, 500_000);
  assert.equal(report.entries[0].outputTokens, 500_000);
});

test('S4: $0.01 tiny rows accepted at any token count (no ratio reject)', () => {
  // $0.01 on 100 tokens ($100/M) and on 99 tokens ($101/M) are both
  // accepted: per-request billing makes any ratio cap unsound as a reject.
  // Implausible $/M is a cost_implausible review flag instead.
  for (const total of [100, 99]) {
    const tiny = parser.parseReport(JSON.stringify({
      type: 'daily',
      daily: [dailyEntry({
        inputTokens: total,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: total,
        totalCost: 0.01,
      })],
    }));
    assert.equal(tiny.entries[0].costUsd, 0.01);
  }
});
