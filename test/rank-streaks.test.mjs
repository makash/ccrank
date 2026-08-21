import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-rank-streaks-'));

async function loadBundle(entryPoint, name) {
  const outdir = path.join(bundleDir, name);
  await build({
    entryPoints: [entryPoint],
    outdir,
    bundle: true,
    entryNames: 'bundle',
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  return import(pathToFileURL(path.join(outdir, 'bundle.js')).href);
}

let stats;
let html;

before(async () => {
  [stats, html] = await Promise.all([
    loadBundle('src/stats.ts', 'stats'),
    loadBundle('src/html.ts', 'html'),
  ]);
});

after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

const TODAY = '2026-08-21';

function day(offset) {
  const t = new Date(TODAY + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + offset);
  return t.toISOString().slice(0, 10);
}

test('computeStreak table', () => {
  const cases = [
    { name: 'empty history', dates: [], current: 0, longest: 0 },
    { name: 'streak through today', dates: [day(-2), day(-1), day(0)], current: 3, longest: 3 },
    { name: 'alive but ended yesterday', dates: [day(-2), day(-1)], current: 2, longest: 2 },
    { name: 'gap yesterday kills current', dates: [day(-3), day(-2)], current: 0, longest: 2 },
    { name: 'only today', dates: [day(0)], current: 1, longest: 1 },
    { name: 'longest ignores recency', dates: [day(-9), day(-8), day(-7), day(-5), day(-4)], current: 0, longest: 3 },
    { name: 'month boundary counts as consecutive', dates: ['2026-07-31', '2026-08-01'], current: 0, longest: 2 },
    { name: 'duplicates and unsorted input', dates: [day(0), day(-1), day(-1), day(0), day(-2)], current: 3, longest: 3 },
    { name: 'single old day', dates: [day(-30)], current: 0, longest: 1 },
  ];
  for (const c of cases) {
    assert.deepEqual(stats.computeStreak(c.dates, TODAY), { current: c.current, longest: c.longest }, c.name);
  }
});

test('computeRankDelta table', () => {
  const cases = [
    { today: 10, yesterday: 12, want: 2, note: 'climbed two spots -> positive' },
    { today: 12, yesterday: 10, want: -2, note: 'dropped two spots -> negative' },
    { today: 5, yesterday: 5, want: 0, note: 'same rank -> zero' },
    { today: null, yesterday: 5, want: null, note: 'no usage today -> null' },
    { today: 5, yesterday: null, want: null, note: 'no usage yesterday -> null' },
    { today: null, yesterday: null, want: null, note: 'no usage either day -> null' },
  ];
  for (const c of cases) {
    assert.equal(stats.computeRankDelta(c.today, c.yesterday), c.want, c.note);
  }
});

function makeUser(overrides = {}) {
  return {
    id: 'u1',
    display_name: 'Ada Lovelace',
    email: 'ada@example.com',
    avatar_url: null,
    is_admin: 0,
    invites_remaining: 3,
    sharing_enabled: 0,
    git_sharing_enabled: 0,
    share_slug: null,
    fav_tools: '[]',
    ...overrides,
  };
}

function baseStats(overrides = {}) {
  return {
    total_cost: 12.5,
    total_tokens: 1234567,
    total_output_tokens: 234567,
    days_active: 4,
    rank: 8,
    upload_count: 2,
    platformBreakdown: {},
    ...overrides,
  };
}

test('dashboard renders streak card with green up delta', () => {
  const page = html.dashboardPage(makeUser(), baseStats({
    streak: { current: 5, longest: 9 },
    rank_today: 12,
    rank_yesterday: 14,
    rank_delta: 2,
  }));
  assert.ok(page.includes('🔥'), 'fire emoji present');
  assert.ok(page.includes('5-day streak'), 'current streak text');
  assert.ok(page.includes('#12 today'), 'today rank text');
  assert.match(page, /\(▲2\)/, 'up arrow with delta');
  assert.match(page, /text-green-400/, 'green class for improvement');
  assert.doesNotMatch(page, /text-red-400/, 'no red class on improvement');
});

test('dashboard renders red down delta on rank drop', () => {
  const page = html.dashboardPage(makeUser(), baseStats({
    streak: { current: 1, longest: 3 },
    rank_today: 7,
    rank_yesterday: 4,
    rank_delta: -3,
  }));
  assert.match(page, /\(▼3\)/, 'down arrow with magnitude');
  assert.match(page, /text-red-400/, 'red class for drop');
  assert.doesNotMatch(page, /\(▲/, 'no up arrow on drop');
});

test('dashboard renders gray em dash when ranks are null', () => {
  const page = html.dashboardPage(makeUser(), baseStats({
    streak: { current: 0, longest: 0 },
    rank_today: null,
    rank_yesterday: null,
    rank_delta: null,
  }));
  assert.ok(page.includes('0-day streak'));
  assert.ok(page.includes('<span class="text-gray-500">—</span>'), 'gray dash when no rank');
  assert.doesNotMatch(page, /[▲▼]/, 'no arrows when ranks are null');
});

test('dashboard defaults gracefully without streak data', () => {
  const page = html.dashboardPage(makeUser(), baseStats());
  assert.ok(page.includes('0-day streak'));
  assert.ok(page.includes('<span class="text-gray-500">—</span>'));
});

test('dashboard escapes user-supplied values', () => {
  const page = html.dashboardPage(
    makeUser({ display_name: '<script>alert(1)</script>' }),
    baseStats({ streak: { current: 2, longest: 2 }, rank_today: 3, rank_yesterday: 3, rank_delta: 0 })
  );
  assert.ok(!page.includes('<script>alert(1)</script>'), 'raw script never injected');
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'display name escaped');
});
