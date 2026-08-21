import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-analytics-'));

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

let analytics;

before(async () => {
  analytics = await loadBundle('src/analytics.ts', 'analytics');
});

after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

const DATES = Array.from({ length: 20 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);

function makeDay(date, i) {
  return {
    date,
    tokens: 1000 + i,
    cost: 1.5,
    users: 3,
    byPlatform: i === 5 ? { claude: 700 } : { claude: 500 + i, grok: 300, opencode: 200 },
  };
}

function makeFixture() {
  const days = DATES.map(makeDay);
  const topUsers = [
    { name: 'Alpha', daily: Object.fromEntries(DATES.map((d, i) => [d, 10 + i])) },
    { name: 'Beta', daily: Object.fromEntries(DATES.map((d, i) => [d, 15 + (i % 4) * 3])) },
    { name: 'Gamma', daily: Object.fromEntries(DATES.map((d, i) => [d, 8 + (i % 5)])) },
    { name: '<script>alert(1)</script>', daily: Object.fromEntries(DATES.map((d, i) => [d, 5 + (i % 3)])) },
  ].map((u) => ({ ...u, total: DATES.reduce((sum, d) => sum + u.daily[d], 0) }));
  return {
    range: 30,
    days,
    totals: { tokens: days.reduce((s, d) => s + d.tokens, 0), cost: 30, users: 7 },
    topUsers,
  };
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('renders stat cards with window totals', () => {
  const page = analytics.analyticsPage(makeFixture());
  // formatTokens(20190) === '20.2K', formatCost(30) === '$30.00'
  assert.match(page, /Active Users/);
  assert.match(page, /Days with Usage/);
  assert.ok(page.includes('$30.00'), 'cost stat card shows $30.00');
  assert.ok(page.includes('20.2K'), 'tokens stat card shows formatted total');
  assert.ok(page.includes('>7</div>'), 'active users count rendered');
  assert.ok(page.includes('>20</div>'), 'days with usage count rendered');
});

test('stacks platform segments in platform order with brand colors', () => {
  const page = analytics.analyticsPage(makeFixture());
  for (const hex of ['#c084fc', '#fb7185', '#fb923c']) {
    assert.ok(page.includes(hex), `${hex} present`);
  }
  const claudeAt = page.indexOf('#c084fc');
  const grokAt = page.indexOf('#fb7185');
  const opencodeAt = page.indexOf('#fb923c');
  assert.ok(claudeAt < grokAt && grokAt < opencodeAt, 'segments appear in PLATFORM_ORDER');
  // formatTokens(1000) === '1.0K' per src/utils.ts
  assert.ok(
    page.includes('title="2026-08-01: 1.0K total (Claude Code 500)"'),
    'bar segment title carries date, day total and platform label'
  );
});

test('omits segments for platforms absent that day', () => {
  const page = analytics.analyticsPage(makeFixture());
  const daysWithGrok = 19;
  // Segment divs end with `background:<hex>" title="..."`; the legend swatch
  // has no title attribute, so this pattern counts bar segments only.
  assert.equal(count(page, 'background:#fb7185" title='), daysWithGrok);
  assert.equal(count(page, '(Grok CLI '), daysWithGrok);
  // The claude-only day (index 5 -> 2026-08-06) renders no Grok segment.
  assert.ok(!page.includes('2026-08-06: 1.0K total (Grok CLI'));
  assert.ok(page.includes('2026-08-06: 1.0K total (Claude Code 700)'));
});

test('top race chart draws one polyline per user with escaped names', () => {
  const page = analytics.analyticsPage(makeFixture());
  const raceStart = page.indexOf('Top 4 Race');
  const raceEnd = page.indexOf('Day-wise');
  const race = page.slice(raceStart, raceEnd);
  assert.equal(count(race, '<polyline'), 4);
  // The layout legitimately ships its own inline <script> tags, so scope the
  // raw-injection check to the race section built from user-supplied names.
  assert.ok(!race.includes('<script'), 'user name never injected raw');
  assert.ok(race.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'name escaped');
  assert.ok(race.includes('<title>Alpha — 2026-08-01: 10</title>'), 'circle markers carry name — date titles');
  assert.equal(count(race, '<circle'), 4 * 20);
});

test('day-wise table caps at 14 rows newest first', () => {
  const page = analytics.analyticsPage(makeFixture());
  const tbody = page.slice(page.indexOf('<tbody>') + '<tbody>'.length, page.indexOf('</tbody>'));
  const dateCell = '<td class="py-2.5 px-4 font-mono text-sm text-gray-300">';
  assert.equal(count(tbody, dateCell), 14);
  assert.ok(tbody.indexOf('2026-08-20') < tbody.indexOf('2026-08-07'), 'newest date listed first');
  assert.ok(!tbody.includes('2026-08-06'), 'rows beyond the 14-day cap are dropped');
});

test('range links reflect active selection', () => {
  const page = analytics.analyticsPage({ ...makeFixture(), range: 90 });
  assert.ok(page.includes('href="/analytics?range=30"'));
  assert.ok(page.includes('href="/analytics?range=90"'));
  const links = [...page.matchAll(/<a href="\/analytics\?range=(\d+)" class="([^"]*)"/g)];
  const byRange = Object.fromEntries(links.map((m) => [m[1], m[2]]));
  assert.match(byRange['90'], /bg-purple-600/, '90d link is active');
  assert.doesNotMatch(byRange['30'], /bg-purple-600/, '30d link is inactive');
});

test('empty state when no data', () => {
  const page = analytics.analyticsPage({ range: 30, days: [], totals: { tokens: 0, cost: 0, users: 0 }, topUsers: [] });
  assert.ok(page.includes('No usage data yet.'));
  assert.ok(!page.includes('<polyline'));
});
