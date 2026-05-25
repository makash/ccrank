/**
 * ccusage JSON report parser
 *
 * Handles multiple report formats from ccusage:
 * - daily: { type: "daily", data: [...], summary: {...} }
 * - weekly: { type: "weekly", data: [...], summary: {...} }
 * - session: { type: "session", data: [...], summary: {...} }
 *
 * Also handles older formats where field names differ
 * (e.g., totalCost vs costUSD vs totalCostUSD)
 */

export interface DailyEntry {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  modelsUsed: string[];
}

export interface ParsedReport {
  type: 'daily' | 'weekly' | 'session';
  entries: DailyEntry[];
  summary: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheCreationTokens: number;
    totalCacheReadTokens: number;
    totalTokens: number;
    totalCostUsd: number;
  };
}

function extractCost(obj: Record<string, unknown>): number {
  // Handle the various cost field names across ccusage versions
  const candidates = ['costUSD', 'cost_usd', 'totalCost', 'totalCostUSD', 'cost'];
  for (const key of candidates) {
    if (typeof obj[key] === 'number') {
      return obj[key] as number;
    }
  }
  return 0;
}

function extractModels(obj: Record<string, unknown>): string[] {
  if (Array.isArray(obj.modelsUsed)) {
    return obj.modelsUsed.map(String);
  }
  if (Array.isArray(obj.models)) {
    return obj.models.map(String);
  }
  if (obj.models && typeof obj.models === 'object') {
    return Object.keys(obj.models);
  }
  if (Array.isArray(obj.modelBreakdowns)) {
    return obj.modelBreakdowns
      .map((breakdown) =>
        breakdown && typeof breakdown === 'object'
          ? String((breakdown as Record<string, unknown>).modelName || '')
          : ''
      )
      .filter(Boolean);
  }
  if (obj.modelBreakdowns && typeof obj.modelBreakdowns === 'object') {
    return Object.keys(obj.modelBreakdowns);
  }
  return [];
}

function num(val: unknown): number {
  return typeof val === 'number' ? val : 0;
}

function normalizeDate(dateValue: unknown, type: string, index: number): string {
  if (dateValue === null || dateValue === undefined || dateValue === '') {
    throw new Error(`Missing date/period for ${type} entry at index ${index}.`);
  }

  const dateStr = String(dateValue);
  // For daily reports, the date should already be YYYY-MM-DD.
  // Newer ccusage versions use "period" for daily rows.
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  // For weekly/monthly/session reports, use the leading date.
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return dateStr.substring(0, 10);
  }

  throw new Error(`Invalid date/period "${dateStr}" for ${type} entry at index ${index}.`);
}

function parseDataEntry(entry: Record<string, unknown>, type: string, index: number): DailyEntry {
  const dateField = entry.date || entry.period || entry.week || entry.month || entry.lastActivity || entry.sessionId;
  return {
    date: normalizeDate(dateField, type, index),
    inputTokens: num(entry.inputTokens),
    outputTokens: num(entry.outputTokens),
    cacheCreationTokens: num(entry.cacheCreationTokens),
    cacheReadTokens: num(entry.cacheReadTokens ?? entry.cachedInputTokens),
    totalTokens: num(entry.totalTokens),
    costUsd: extractCost(entry),
    modelsUsed: extractModels(entry),
  };
}

function parseSummary(summary: Record<string, unknown>) {
  return {
    totalInputTokens: num(summary.totalInputTokens ?? summary.inputTokens),
    totalOutputTokens: num(summary.totalOutputTokens ?? summary.outputTokens),
    totalCacheCreationTokens: num(summary.totalCacheCreationTokens ?? summary.cacheCreationTokens),
    totalCacheReadTokens: num(summary.totalCacheReadTokens ?? summary.cacheReadTokens ?? summary.cachedInputTokens),
    totalTokens: num(summary.totalTokens),
    totalCostUsd: extractCost(summary),
  };
}

export function parseReport(jsonStr: string): ParsedReport {
  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    throw new Error('Invalid JSON. Please paste the output of `npx ccusage@latest daily --json`.');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Expected a JSON object. Please paste the output of `npx ccusage@latest daily --json`.');
  }

  const report = data as Record<string, unknown>;

  // Detect report type
  let type: 'daily' | 'weekly' | 'session' = 'daily';
  if (typeof report.type === 'string') {
    const t = report.type.toLowerCase();
    if (t === 'weekly') type = 'weekly';
    else if (t === 'session' || t === 'sessions') type = 'session';
  }

  // Extract data array
  let entries: Record<string, unknown>[] = [];
  if (Array.isArray(report.data)) {
    entries = report.data;
  } else if (Array.isArray(report.daily)) {
    entries = report.daily;
    type = 'daily';
  } else if (Array.isArray(report.weekly)) {
    entries = report.weekly;
    type = 'weekly';
  } else if (Array.isArray(report.sessions)) {
    entries = report.sessions;
    type = 'session';
  } else {
    throw new Error(
      'Could not find data array in report. Expected "data", "daily", "weekly", or "sessions" key.'
    );
  }

  if (entries.length === 0) {
    throw new Error('Report contains no data entries.');
  }

  // Parse each entry
  const parsedEntries = entries.map((entry, i) => parseDataEntry(entry, type, i));

  // Parse summary if present, otherwise compute from entries
  let summary: ParsedReport['summary'];
  const rawSummary = report.summary ?? report.totals;
  if (rawSummary && typeof rawSummary === 'object') {
    summary = parseSummary(rawSummary as Record<string, unknown>);
  } else {
    summary = {
      totalInputTokens: parsedEntries.reduce((s, e) => s + e.inputTokens, 0),
      totalOutputTokens: parsedEntries.reduce((s, e) => s + e.outputTokens, 0),
      totalCacheCreationTokens: parsedEntries.reduce((s, e) => s + e.cacheCreationTokens, 0),
      totalCacheReadTokens: parsedEntries.reduce((s, e) => s + e.cacheReadTokens, 0),
      totalTokens: parsedEntries.reduce((s, e) => s + e.totalTokens, 0),
      totalCostUsd: parsedEntries.reduce((s, e) => s + e.costUsd, 0),
    };
  }

  // For session reports, aggregate by lastActivity date
  if (type === 'session') {
    const byDate = new Map<string, DailyEntry>();
    for (const entry of entries) {
      const raw = entry as Record<string, unknown>;
      const parsed = parseDataEntry(raw, type, 0);
      const lastActivity = raw.lastActivity ? normalizeDate(raw.lastActivity, type, 0) : parsed.date;
      const existing = byDate.get(lastActivity);
      parsed.date = lastActivity;

      if (existing) {
        existing.inputTokens += parsed.inputTokens;
        existing.outputTokens += parsed.outputTokens;
        existing.cacheCreationTokens += parsed.cacheCreationTokens;
        existing.cacheReadTokens += parsed.cacheReadTokens;
        existing.totalTokens += parsed.totalTokens;
        existing.costUsd += parsed.costUsd;
        const modelSet = new Set([...existing.modelsUsed, ...parsed.modelsUsed]);
        existing.modelsUsed = Array.from(modelSet);
      } else {
        byDate.set(lastActivity, parsed);
      }
    }
    return { type, entries: Array.from(byDate.values()), summary };
  }

  return { type, entries: parsedEntries, summary };
}
