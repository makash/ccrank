import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'ccrank-profile-trends-'));

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
let html;

before(async () => {
  [analytics, html] = await Promise.all([
    loadBundle('src/analytics.ts', 'analytics'),
    loadBundle('src/html.ts', 'html'),
  ]);
});

after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ─── sparklineBars unit tests ──────────────────────────────────────────────────

test('sparklineBars renders one w-2 rounded-sm bar per value inside a flex items-end h-12 row', () => {
  const markup = analytics.sparklineBars([10, 20, 30], '#c084fc');
  assert.ok(markup.includes('class="flex items-end gap-1 h-12"'), 'row container matches renderSparkline style');
  assert.equal(count(markup, 'class="w-2 rounded-sm"'), 3);
});

test('sparklineBars floors tiny values at min-height 2px and scales max to 48px', () => {
  const markup = analytics.sparklineBars([0, 100], '#34d399');
  assert.ok(markup.includes('height:2px'), 'zero-value bar hits the 2px floor');
  assert.ok(markup.includes('height:48px'), 'max-value bar scales to 48px');
  assert.ok(markup.includes('background:#34d399'), 'inline background style uses the given color');
});

test('sparklineBars emits escaped title tooltips when titles are provided', () => {
  const markup = analytics.sparklineBars(
    [1000, 2_000_000],
    '#c084fc',
    ['2026-08-01: 1.0K', '2026-08-02"><script>alert(1)</script>: 2.0M']
  );
  assert.ok(markup.includes('title="2026-08-01: 1.0K"'), 'tooltip follows DATE: formatTokens(v)');
  assert.ok(markup.includes('title="2026-08-02&quot;&gt;&lt;script&gt;'), 'hostile title content is escaped');
  assert.ok(!markup.includes('<script>alert(1)</script>'), 'raw script never injected');
});

test('sparklineBars omits title attributes when no titles given', () => {
  const markup = analytics.sparklineBars([5, 5], '#38bdf8');
  assert.equal(count(markup, 'title='), 0);
});

// ─── profilePage trend panel tests ─────────────────────────────────────────────

const profileUser = { id: 'u1', display_name: 'Tester', avatar_url: null, share_slug: 'tester' };

function makeStats(platformBreakdown) {
  return {
    total_cost: 12,
    total_tokens: 3_000_000,
    total_output_tokens: 300_000,
    days_active: 5,
    rank: 4,
    last_active: '2026-08-20',
    output_per_dollar: 25000,
    cache_rate: 0.5,
    output_ratio: 0.1,
    meets_efficiency_threshold: false,
    platformBreakdown,
  };
}

function makeTrendData() {
  return {
    dates: ['2026-08-01', '2026-08-02'],
    totalByDate: { '2026-08-01': 150, '2026-08-02': 2_000_000 },
    byPlatformByDate: {
      '2026-08-01': { claude: 100, codex: 50 },
      '2026-08-02': { claude: 1_000_000, codex: 900_000, kimi: 100_000 },
    },
  };
}

function renderProfile(trendData) {
  return html.profilePage(
    profileUser,
    makeStats({
      claude: { total_cost: 8, total_tokens: 1_000_100, total_output_tokens: 100_000, days_active: 2, last_active: '2026-08-02' },
      codex: { total_cost: 3, total_tokens: 950_000, total_output_tokens: 90_000, days_active: 2, last_active: '2026-08-02' },
      kimi: { total_cost: 1, total_tokens: 100_000, total_output_tokens: 10_000, days_active: 1, last_active: '2026-08-02' },
    }),
    [],
    [],
    null,
    false,
    null,
    trendData
  );
}

test('profile renders the 30-day trend panel with purple bars and tooltips at >=2 days', () => {
  const page = renderProfile(makeTrendData());
  assert.ok(page.includes('30-day trend'), 'trend panel heading present');
  const panelStart = page.indexOf('30-day trend');
  const panelEnd = page.indexOf('Platform Breakdown');
  const panel = page.slice(panelStart, panelEnd);
  assert.ok(panel.includes('#c084fc'), 'panel uses #c084fc');
  assert.equal(count(panel, 'class="w-2 rounded-sm"'), 2, 'one bar per day, oldest to newest');
  assert.ok(panel.includes('title="2026-08-01: 150"'), 'first bar tooltip shows oldest day');
  assert.ok(panel.includes('title="2026-08-02: 2.0M"'), 'second bar tooltip formats tokens');
});

test('profile hides the whole trend panel with fewer than 2 days of data', () => {
  const oneDay = { dates: ['2026-08-01'], totalByDate: { '2026-08-01': 150 }, byPlatformByDate: { '2026-08-01': { claude: 150 } } };
  assert.ok(!renderProfile(oneDay).includes('30-day trend'), 'hidden at 1 day');
  assert.ok(!renderProfile(undefined).includes('30-day trend'), 'hidden when trendData missing');
  assert.ok(!renderProfile(null).includes('30-day trend'), 'hidden when trendData null');
});

test('per-platform sparklines use the platform dot hex colors and only appear at >=2 active days', () => {
  const page = renderProfile(makeTrendData());
  const breakdownStart = page.indexOf('Platform Breakdown');
  const breakdown = page.slice(breakdownStart);

  const claudeCard = breakdown.slice(breakdown.indexOf('Claude Code'), breakdown.indexOf('Codex CLI'));
  assert.ok(claudeCard.includes('#c084fc'), 'claude sparkline uses purple #c084fc');
  assert.equal(count(claudeCard, 'class="w-2 rounded-sm"'), 2, 'claude has 2 active days');

  const codexCard = breakdown.slice(breakdown.indexOf('Codex CLI'), breakdown.indexOf('Kimi Code'));
  assert.ok(codexCard.includes('#34d399'), 'codex sparkline uses emerald #34d399');

  const kimiCard = breakdown.slice(breakdown.indexOf('Kimi Code'));
  assert.ok(!kimiCard.includes('#38bdf8'), 'kimi (1 active day) gets no sparkline');
  assert.ok(!kimiCard.includes('w-2 rounded-sm'), 'kimi card has no bars');
});

test('trend tooltips escape hostile date content', () => {
  const hostile = {
    dates: ['2026-08-01', '2026-08-02"><script>alert(1)</script>'],
    totalByDate: { '2026-08-01': 10, '2026-08-02"><script>alert(1)</script>': 20 },
    byPlatformByDate: {
      '2026-08-01': { claude: 10 },
      '2026-08-02"><script>alert(1)</script>': { claude: 20 },
    },
  };
  const page = renderProfile(hostile);
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'injection rendered inert');
  assert.ok(!page.includes('<script>alert(1)</script>'), 'raw payload never reaches markup');
});
