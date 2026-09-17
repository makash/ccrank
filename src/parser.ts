/**
 * ccusage JSON report parser
 *
 * Handles multiple report formats from ccusage and @ccusage/codex:
 * - daily: { type: "daily", data: [...] | daily: [...], summary/totals: {...} }
 * - weekly: { type: "weekly", data: [...] | weekly: [...], summary/totals: {...} }
 * - session: { type: "session", data: [...] | sessions: [...], summary/totals: {...} }
 *
 * Also handles older formats where field names differ
 * (e.g., totalCost vs costUSD vs totalCostUSD) and newer ccusage
 * versions where daily rows use `period` instead of `date`.
 */

export type Platform = 'claude' | 'codex' | 'kimi' | 'grok' | 'glm' | 'pi' | 'opencode' | 'cursor' | 'muse';

export interface DailyEntry {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  modelsUsed: string[];
  platform: Platform;
}

export interface ParsedReport {
  type: 'daily' | 'weekly' | 'session';
  entries: DailyEntry[];
  platform: Platform;
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
      .map((model) => {
        if (!model || typeof model !== 'object') return '';
        const raw = model as Record<string, unknown>;
        return String(raw.modelName ?? raw.model ?? raw.name ?? '');
      })
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

// $100 per million tokens: documented as 30%+ above all-Opus-everything.
// Anything pricier is a corrupt or hostile row, not real usage.
// ponytail: ceiling $100/M tokens. Signal this cap is wrong = legit costUsd
// 400s on real vendor bills. Next rung if it fires = per-platform caps.
const MAX_COST_USD_PER_MILLION_TOKENS = 100;

// Rejects absurd rows before they can poison max-merged history (usage
// totals may only ever go UP, so a bad row could never be lowered away).
// Throws are mapped to HTTP 400 by POST /api/upload in src/index.ts.
function validateEntry(entry: DailyEntry, raw: Record<string, unknown>, index: number, maxDate: string): void {
  const tokenFields: Array<[string, number]> = [
    ['inputTokens', entry.inputTokens],
    ['outputTokens', entry.outputTokens],
    ['cacheCreationTokens', entry.cacheCreationTokens],
    ['cacheReadTokens', entry.cacheReadTokens],
    ['totalTokens', entry.totalTokens],
  ];
  for (const [name, value] of tokenFields) {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid ${name} for entry at index ${index}: expected a finite number.`);
    }
    if (value < 0) {
      throw new Error(`Invalid ${name} for entry at index ${index}: negative values are not allowed.`);
    }
  }
  if (!Number.isFinite(entry.costUsd) || entry.costUsd < 0) {
    throw new Error(`Invalid costUsd for entry at index ${index}: expected a finite non-negative number.`);
  }

  // Presence-aware: HEAD accepts rows with omitted fields (num() coerces to 0);
  // only enforce consistency when the reporter actually sent a total.
  // Total-only rows (total present, components omitted) intentionally still
  // 400 here: an uncorroborated total cannot ground max-merged history, and
  // skipping the check on omitted components would let any hostile row dodge
  // it by omission. A reject is recoverable (re-upload full rows); a poisoned
  // total under never-lower is not. Pinned by the S2 test.
  if (typeof raw.totalTokens === 'number') {
    const componentSum =
      entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
    const tolerance = Math.max(1, Math.abs(entry.totalTokens) * 0.001);
    if (Math.abs(entry.totalTokens - componentSum) > tolerance) {
      throw new Error(
        `Inconsistent totalTokens for entry at index ${index}: ${entry.totalTokens} differs from component sum ${componentSum} beyond tolerance ${tolerance}.`
      );
    }
  }

  // $0-cost rows with tokens stay accepted: 0 is never above the cap.
  const maxCostUsd = (entry.totalTokens / 1e6) * MAX_COST_USD_PER_MILLION_TOKENS;
  if (entry.costUsd > maxCostUsd) {
    throw new Error(
      `Implausible costUsd for entry at index ${index}: $${entry.costUsd} exceeds $${MAX_COST_USD_PER_MILLION_TOKENS}/M tokens for ${entry.totalTokens} tokens.`
    );
  }

  // Lexicographic compare works on normalized YYYY-MM-DD dates. One day of
  // grace keeps uploads from any timezone near midnight UTC accepted.
  // maxDate is computed once per parseReport call and threaded through.
  if (entry.date > maxDate) {
    throw new Error(
      `Future date "${entry.date}" for entry at index ${index}: dates after ${maxDate} are not allowed.`
    );
  }
}

// Vendor checks run before the Pi check so a model Pi merely fronts is ranked
// under the vendor that owns it, matching piPlatformForModel in the CLI.
export function detectPlatform(models: string[]): Platform {
  const kimiContains = ['kimi', 'moonshot'];
  const grokContains = ['grok', 'xai'];
  const glmContains = ['glm', 'zai', 'z-ai'];
  const codexPrefixes = ['gpt-', 'codex-', 'o1-', 'o3-', 'o4-'];
  const codexContains = ['codex', 'openai'];
  const piPrefixes = ['pi-', '[pi] '];
  for (const model of models) {
    const lower = model.toLowerCase();
    // Cursor Agent/CLI run composer, cursor-*, and vendor models under one
    // client. Check Cursor before kimi/grok/glm/codex so a Cursor-hosted
    // grok/claude/gpt model is not refiled into those platforms. Bare vendor
    // names without a cursor-/composer- marker stay on their own platforms.
    if (lower.startsWith('cursor-') || lower.startsWith('cursor/')) return 'cursor';
    if (lower === 'composer' || lower.startsWith('composer-')) return 'cursor';
    // Muse Code serves muse-spark models (e.g. "muse-spark-1.3-contributor").
    // Check before the vendor checks so a Pi-fronted "pi-meta-muse-spark-…"
    // name still resolves to the vendor that owns it.
    if (lower.includes('muse')) return 'muse';
    if (kimiContains.some((part) => lower.includes(part))) return 'kimi';
    if (grokContains.some((part) => lower.includes(part))) return 'grok';
    if (glmContains.some((part) => lower.includes(part))) return 'glm';
    // OpenCode models carry their provider prefix ("opencode/x-preview-f-free").
    if (lower.startsWith('opencode/')) return 'opencode';
    // Pi is checked before Codex so an OpenAI model Pi fronts is ranked as Pi
    // usage rather than as Codex CLI usage, which is what the CLI does.
    if (piPrefixes.some((prefix) => lower.startsWith(prefix))) return 'pi';
    if (codexPrefixes.some((prefix) => lower.startsWith(prefix))) return 'codex';
    if (codexContains.some((part) => lower.includes(part))) return 'codex';
  }
  return 'claude';
}

function normalizeDate(dateValue: unknown, type: string, index: number): string {
  if (dateValue === null || dateValue === undefined || dateValue === '') {
    throw new Error(`Missing date/period for ${type} entry at index ${index}.`);
  }

  const dateStr = String(dateValue);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  // For weekly/monthly/session reports, use the leading date.
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return dateStr.substring(0, 10);
  }

  throw new Error(`Invalid date/period "${dateStr}" for ${type} entry at index ${index}.`);
}

function parseDataEntry(entry: Record<string, unknown>, type: string, index: number, maxDate: string): DailyEntry {
  const dateField = entry.date || entry.period || entry.week || entry.month || entry.lastActivity || entry.sessionId;
  const models = extractModels(entry);
  const parsed: DailyEntry = {
    date: normalizeDate(dateField, type, index),
    inputTokens: num(entry.inputTokens),
    outputTokens: num(entry.outputTokens),
    cacheCreationTokens: num(entry.cacheCreationTokens),
    cacheReadTokens: num(entry.cacheReadTokens ?? entry.cachedInputTokens),
    totalTokens: num(entry.totalTokens),
    costUsd: extractCost(entry),
    modelsUsed: models,
    platform: detectPlatform(models),
  };
  validateEntry(parsed, entry, index, maxDate);
  return parsed;
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
    throw new Error('Invalid JSON. Please paste the output of `npx ccusage@latest daily --json` or `npx @ccusage/codex@latest daily --json`.');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Expected a JSON object. Please paste the output of `npx ccusage@latest daily --json` or `npx @ccusage/codex@latest daily --json`.');
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
  // Future-date ceiling (today+1d UTC grace), computed once per upload so
  // every row is judged against the same cutoff.
  const maxDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const parsedEntries = entries.map((entry, i) => parseDataEntry(entry, type, i, maxDate));

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
    // A repeated sessionId would be SUMmed twice below; reject the upload.
    // Rows without a sessionId carry no identity signal and are skipped.
    // Anon (null/empty) sessionId skip is an honest-client guard, not an abuse boundary.
    const seenSessionIds = new Set<string>();
    for (const entry of entries) {
      const sessionId = (entry as Record<string, unknown>).sessionId;
      if (sessionId === null || sessionId === undefined || sessionId === '') continue;
      // String() folds 1/'1' to one key; the collision errs toward duplicate-reject (fail-closed), never double-SUM.
      const key = String(sessionId);
      if (seenSessionIds.has(key)) {
        throw new Error(`Duplicate sessionId "${key}" in session upload.`);
      }
      seenSessionIds.add(key);
    }
    // H1: lastActivity overwrites the validated date below, so it must pass
    // the same future-date rule (lexicographic YYYY-MM-DD, one-day grace),
    // reusing the per-upload maxDate computed above.
    // Single validation pass: reuse parsedEntries[i] (already validated with
    // the real index above) instead of re-parsing every row at index 0.
    for (let i = 0; i < entries.length; i++) {
      const raw = entries[i] as Record<string, unknown>;
      const parsed = parsedEntries[i];
      const lastActivity = raw.lastActivity ? normalizeDate(raw.lastActivity, type, i) : parsed.date;
      if (lastActivity > maxDate) {
        throw new Error(`Future date "${lastActivity}" in session upload: dates after ${maxDate} are not allowed.`);
      }
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
        existing.platform = detectPlatform(existing.modelsUsed);
      } else {
        byDate.set(lastActivity, parsed);
      }
    }
    const sessionEntries = Array.from(byDate.values());
    const reportPlatform = detectPlatform(sessionEntries.flatMap((entry) => entry.modelsUsed));
    return { type, entries: sessionEntries, platform: reportPlatform, summary };
  }

  const reportPlatform = detectPlatform(parsedEntries.flatMap((entry) => entry.modelsUsed));
  return { type, entries: parsedEntries, platform: reportPlatform, summary };
}
