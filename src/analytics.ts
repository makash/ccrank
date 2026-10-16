import { escapeHtml, formatCost, formatPercent, formatTokens, type User } from './utils';
import { layout } from './html';
import type { ModelUsage, ModelUsageSummary, PlatformModels } from './models';

const PLATFORM_ORDER = ['claude', 'codex', 'kimi', 'grok', 'glm', 'pi', 'opencode', 'cursor', 'muse'];

const PLATFORM_COLORS: Record<string, { hex: string; label: string }> = {
  claude: { hex: '#c084fc', label: 'Claude Code' },
  codex: { hex: '#34d399', label: 'Codex CLI' },
  kimi: { hex: '#38bdf8', label: 'Kimi Code' },
  grok: { hex: '#fb7185', label: 'Grok CLI' },
  glm: { hex: '#fbbf24', label: 'GLM (Z Code)' },
  pi: { hex: '#2dd4bf', label: 'Pi' },
  opencode: { hex: '#fb923c', label: 'OpenCode' },
  cursor: { hex: '#818cf8', label: 'Cursor' },
  muse: { hex: '#e879f9', label: 'Muse Code' },
};

const LINE_COLORS = ['#a78bfa', '#34d399', '#38bdf8', '#fbbf24'];

export interface AnalyticsDay {
  date: string;
  tokens: number;
  cost: number;
  users: number;
  byPlatform: Record<string, number>;
}

export interface AnalyticsUserSeries {
  name: string;
  total: number;
  daily: Record<string, number>;
}

export interface AnalyticsData {
  range: number;
  days: AnalyticsDay[];
  totals: { tokens: number; cost: number; users: number };
  topUsers: AnalyticsUserSeries[];
  /** Absent when the model query failed; the section is then hidden. */
  models?: ModelUsageSummary;
}

function statCard(label: string, value: string, valueClass: string): string {
  return `<div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
    <div class="text-sm text-gray-400 mb-1">${label}</div>
    <div class="text-2xl font-bold ${valueClass}">${value}</div>
  </div>`;
}

function platformLegend(present: Set<string>): string {
  return PLATFORM_ORDER.filter((p) => present.has(p))
    .map(
      (p) =>
        `<span class="inline-flex items-center gap-1.5 text-xs text-gray-400"><span class="w-2 h-2 rounded-full" style="background:${PLATFORM_COLORS[p].hex}"></span>${PLATFORM_COLORS[p].label}</span>`
    )
    .join('');
}

function dailyConsumptionChart(days: AnalyticsDay[]): string {
  const maxDay = Math.max(...days.map((d) => d.tokens), 1);
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));
  const columns = days
    .map((day, i) => {
      const segments = PLATFORM_ORDER.filter((p) => (day.byPlatform[p] || 0) > 0)
        .map((p) => {
          const share = (day.byPlatform[p] / maxDay) * 100;
          const tooltip = `${day.date}: ${formatTokens(day.tokens)} total (${PLATFORM_COLORS[p].label} ${formatTokens(day.byPlatform[p])})`;
          return `<div style="height:${share}%;min-height:2px;background:${PLATFORM_COLORS[p].hex}" title="${tooltip}"></div>`;
        })
        .join('');
      const label =
        i % labelEvery === 0 || i === days.length - 1
          ? `<div class="text-[10px] text-gray-500 mt-1 overflow-visible whitespace-nowrap">${day.date.slice(5)}</div>`
          : '<div class="text-[10px] text-transparent mt-1">·</div>';
      return `<div class="flex-1 flex flex-col justify-end items-stretch" style="height:160px">${segments}</div><div class="flex-1">${label}</div>`;
    })
    .join('');
  return `<div class="flex items-start justify-between mb-2">
      <div class="text-xs text-gray-500">peak ${formatTokens(maxDay)}</div>
      <div class="flex flex-wrap gap-3">${platformLegend(new Set(days.flatMap((d) => Object.keys(d.byPlatform))))}</div>
    </div>
    <div class="flex items-end gap-[2px]">${columns}</div>`;
}

// Zero cost means "not reported" (Kimi, Grok, GLM, Muse log tokens only), so
// show a dash rather than a misleading $0.00.
function perMillion(cost: number, tokens: number): string {
  if (cost <= 0 || tokens <= 0) return '—';
  const rate = cost / (tokens / 1_000_000);
  return rate < 0.01 ? '<$0.01' : formatCost(rate);
}

function modelRow(model: ModelUsage, platformTokens: number, hex: string): string {
  const share = platformTokens > 0 ? model.totalTokens / platformTokens : 0;
  const cacheRate = model.totalTokens > 0 ? model.cacheReadTokens / model.totalTokens : 0;
  return `<tr class="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
        <td class="py-2 px-3 font-mono text-sm text-gray-300 break-all">${escapeHtml(model.model)}</td>
        <td class="py-2 px-3 text-right font-mono text-cyan-400">${formatTokens(model.totalTokens)}</td>
        <td class="py-2 px-3 text-right font-mono text-green-400">${formatTokens(model.outputTokens)}</td>
        <td class="py-2 px-3 text-right text-sm text-gray-400">${formatPercent(cacheRate)}</td>
        <td class="py-2 px-3 text-right font-mono text-purple-400">${model.costUsd > 0 ? formatCost(model.costUsd) : '—'}</td>
        <td class="py-2 px-3 text-right text-sm text-gray-400">${perMillion(model.costUsd, model.totalTokens)}</td>
        <td class="py-2 px-3 text-right text-sm text-gray-400">${model.users}</td>
        <td class="py-2 px-3 text-right text-sm text-gray-400 whitespace-nowrap"><span class="inline-block align-middle w-14 h-1.5 rounded bg-gray-800 mr-2"><span class="block h-1.5 rounded" style="width:${(share * 100).toFixed(1)}%;background:${hex}"></span></span>${formatPercent(share)}</td>
      </tr>`;
}

function platformModelsBlock(group: PlatformModels): string {
  const meta = PLATFORM_COLORS[group.platform];
  const rows = group.models.map((model) => modelRow(model, group.totalTokens, meta.hex)).join('');
  const hiddenCount = group.modelCount - group.models.length;
  const hiddenTokens = group.totalTokens - group.models.reduce((sum, model) => sum + model.totalTokens, 0);
  const more =
    hiddenCount > 0
      ? `<tr><td colspan="8" class="py-2 px-3 text-xs text-gray-500">+${hiddenCount} more model${hiddenCount === 1 ? '' : 's'} · ${formatTokens(hiddenTokens)}</td></tr>`
      : '';
  return `<div class="mb-6 last:mb-0">
    <div class="flex flex-wrap items-center gap-x-2 mb-2">
      <span class="w-2.5 h-2.5 rounded-full" style="background:${meta.hex}"></span>
      <span class="text-sm font-semibold text-gray-200">${meta.label}</span>
      <span class="text-xs text-gray-500">${formatTokens(group.totalTokens)} tokens · ${group.costUsd > 0 ? formatCost(group.costUsd) : 'cost n/a'} · ${group.modelCount} model${group.modelCount === 1 ? '' : 's'}</span>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full min-w-[900px] table-fixed text-left">
        <thead>
          <tr class="border-b border-gray-800 text-xs uppercase tracking-wider text-gray-500">
            <th class="py-2 px-3 font-medium">Model</th>
            <th class="py-2 px-3 font-medium text-right w-24">Tokens</th>
            <th class="py-2 px-3 font-medium text-right w-20">Output</th>
            <th class="py-2 px-3 font-medium text-right w-28 whitespace-nowrap" title="Cache-read tokens as a share of total tokens">Cache Rate</th>
            <th class="py-2 px-3 font-medium text-right w-28">Cost</th>
            <th class="py-2 px-3 font-medium text-right w-20" title="Estimated cost per million tokens">$/M</th>
            <th class="py-2 px-3 font-medium text-right w-16">Users</th>
            <th class="py-2 px-3 font-medium text-right w-36">Share</th>
          </tr>
        </thead>
        <tbody>${rows}${more}</tbody>
      </table>
    </div>
  </div>`;
}

function modelsByPlatformCard(summary: ModelUsageSummary | undefined, windowTokens: number): string {
  if (!summary) return '';
  // Unknown platform strings (legacy rows) have no label or color, so skip them.
  const blocks = PLATFORM_ORDER.flatMap((key) => {
    const group = summary.platforms.find((p) => p.platform === key);
    return group ? [platformModelsBlock(group)] : [];
  }).join('');
  // Rows uploaded before per-model tracking carry no breakdown, so say how
  // much of the window the table actually covers.
  const coverage = windowTokens > 0 ? Math.min(1, summary.attributedTokens / windowTokens) : 0;
  return `<div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <div class="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          <h2 class="text-sm font-semibold text-gray-200">Models by Platform</h2>
          ${blocks ? `<span class="text-xs text-gray-500">Model detail covers ${formatPercent(coverage)} of tokens in this window</span>` : ''}
        </div>
        ${blocks || '<p class="text-sm text-gray-500">No per-model data yet. It fills in as machines upload.</p>'}
      </div>`;
}

function topRaceChart(data: AnalyticsData): string {
  const dates = data.days.map((d) => d.date);
  const width = 720;
  const height = 240;
  const padL = 56;
  const padR = 12;
  const padT = 12;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const maxY = Math.max(...data.topUsers.flatMap((u) => Object.values(u.daily)), 1);
  const x = (i: number) => padL + (dates.length === 1 ? plotW / 2 : (i * plotW) / (dates.length - 1));
  const y = (v: number) => padT + (1 - v / maxY) * plotH;

  const gridLines = [0, 0.5, 1]
    .map((f) => {
      const gy = padT + f * plotH;
      const label = formatTokens(maxY * (1 - f));
      return `<line x1="${padL}" y1="${gy}" x2="${width - padR}" y2="${gy}" stroke="#374151" stroke-width="1" stroke-dasharray="3,3"/><text x="${padL - 8}" y="${gy + 4}" fill="#9ca3af" font-size="11" text-anchor="end">${label}</text>`;
    })
    .join('');

  const xLabels = dates
    .filter((_, i) => i % Math.max(1, Math.ceil(dates.length / 7)) === 0 || i === dates.length - 1)
    .map((d) => {
      const i = dates.indexOf(d);
      return `<text x="${x(i)}" y="${height - 8}" fill="#6b7280" font-size="10" text-anchor="middle">${d.slice(5)}</text>`;
    })
    .join('');

  const series = data.topUsers
    .map((u, idx) => {
      const color = LINE_COLORS[idx % LINE_COLORS.length];
      const points = dates.map((d, i) => `${x(i)},${y(u.daily[d] || 0)}`).join(' ');
      const markers = dates
        .map((d, i) => {
          const v = u.daily[d] || 0;
          return `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${color}"><title>${escapeHtml(u.name)} — ${d}: ${formatTokens(v)}</title></circle>`;
        })
        .join('');
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>${markers}`;
    })
    .join('');

  const legend = data.topUsers
    .map(
      (u, idx) =>
        `<span class="inline-flex items-center gap-1.5 text-xs text-gray-300"><span class="w-2.5 h-2.5 rounded-full" style="background:${LINE_COLORS[idx % LINE_COLORS.length]}"></span>${escapeHtml(u.name)} · ${formatTokens(u.total)}</span>`
    )
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" class="w-full" role="img" aria-label="Top 4 users daily token race">
    ${gridLines}${xLabels}${series}
  </svg>
  <div class="flex flex-wrap gap-4 mt-3">${legend}</div>`;
}

function dayWiseTable(days: AnalyticsDay[]): string {
  const rows = [...days]
    .slice(-14)
    .reverse()
    .map((day) => {
      const topPlatform = PLATFORM_ORDER.reduce(
        (best, p) => ((day.byPlatform[p] || 0) > (day.byPlatform[best] || 0) ? p : best),
        PLATFORM_ORDER[0]
      );
      const topLabel = (day.byPlatform[topPlatform] || 0) > 0 ? PLATFORM_COLORS[topPlatform].label : '—';
      return `<tr class="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
        <td class="py-2.5 px-4 font-mono text-sm text-gray-300">${day.date}</td>
        <td class="py-2.5 px-4 text-right font-mono text-cyan-400">${formatTokens(day.tokens)}</td>
        <td class="py-2.5 px-4 text-right font-mono text-purple-400">${formatCost(day.cost)}</td>
        <td class="py-2.5 px-4 text-right text-sm text-gray-400">${day.users}</td>
        <td class="py-2.5 px-4 text-right text-sm text-gray-400">${topLabel}</td>
      </tr>`;
    })
    .join('');
  return `<table class="w-full text-left">
    <thead>
      <tr class="border-b border-gray-800 text-xs uppercase tracking-wider text-gray-500">
        <th class="py-2.5 px-4 font-medium">Date</th>
        <th class="py-2.5 px-4 font-medium text-right">Tokens</th>
        <th class="py-2.5 px-4 font-medium text-right">Cost</th>
        <th class="py-2.5 px-4 font-medium text-right">Active Users</th>
        <th class="py-2.5 px-4 font-medium text-right">Top Platform</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function analyticsPage(data: AnalyticsData, user: User | null = null): string {
  const rangeLink = (value: number, label: string) =>
    `<a href="/analytics?range=${value}" class="px-3 py-1.5 rounded-lg text-sm transition ${data.range === value ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}">${label}</a>`;

  const content = `<div class="max-w-6xl mx-auto px-4 py-8">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">Analytics</h1>
      <div class="flex gap-2">${rangeLink(30, '30d')}${rangeLink(90, '90d')}</div>
    </div>
    ${
      data.days.length === 0
        ? `<div class="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center text-gray-400">No usage data yet.</div>`
        : `<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        ${statCard('Tokens', formatTokens(data.totals.tokens), 'text-cyan-400')}
        ${statCard('Cost', formatCost(data.totals.cost), 'text-purple-400')}
        ${statCard('Active Users', String(data.totals.users), 'text-emerald-400')}
        ${statCard('Days with Usage', String(data.days.length), 'text-amber-400')}
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-sm font-semibold text-gray-200 mb-4">Daily Consumption</h2>
        ${dailyConsumptionChart(data.days)}
      </div>
      ${modelsByPlatformCard(data.models, data.totals.tokens)}
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-sm font-semibold text-gray-200 mb-4">Top 4 Race — Daily Tokens</h2>
        ${topRaceChart(data)}
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-sm font-semibold text-gray-200 mb-4">Day-wise</h2>
        ${dayWiseTable(data.days)}
      </div>
      <p class="text-xs text-gray-600 text-center">Aggregated from daily uploads. Zero-usage correction days are excluded.</p>`
    }
  </div>`;

  return layout('Analytics | ccrank.dev', content, user);
}
