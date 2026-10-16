/**
 * Per-model usage by platform, aggregated from daily_usage.model_breakdowns.
 *
 * Grouping happens in SQL (json_each) so only one row per (platform, model)
 * crosses the wire, not every daily row's JSON. Rows written before
 * migration 0014 have a NULL breakdown and are simply not attributed.
 */

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  users: number;
}

export interface PlatformModels {
  platform: string;
  /** Across every model of the platform, including ones past the display cap. */
  totalTokens: number;
  costUsd: number;
  modelCount: number;
  /** Biggest first, capped at the per-platform display limit. */
  models: ModelUsage[];
}

export interface ModelUsageSummary {
  platforms: PlatformModels[];
  /** Tokens that carry a per-model breakdown, across all platforms. */
  attributedTokens: number;
}

const MODELS_PER_PLATFORM = 8;
// Bounds the result set; ordered biggest-first so the tail is what drops.
const MODEL_GROUP_LIMIT = 400;

// Output aliases avoid the daily_usage column names (platform, total_tokens)
// so GROUP BY / ORDER BY can never bind to the wrong thing. json_valid keeps
// one hand-edited bad row from failing the whole query.
export const MODEL_USAGE_SQL = `SELECT COALESCE(d.platform, 'claude') AS plat,
    json_extract(j.value, '$.modelName') AS model,
    SUM(json_extract(j.value, '$.inputTokens')) AS input,
    SUM(json_extract(j.value, '$.outputTokens')) AS output,
    SUM(json_extract(j.value, '$.cacheCreationTokens')) AS cache_creation,
    SUM(json_extract(j.value, '$.cacheReadTokens')) AS cache_read,
    SUM(json_extract(j.value, '$.totalTokens')) AS tokens,
    SUM(json_extract(j.value, '$.cost')) AS cost,
    COUNT(DISTINCT d.user_id) AS users
  FROM daily_usage d, json_each(d.model_breakdowns) j
  WHERE d.total_tokens > 0 AND d.date >= ?
    AND d.model_breakdowns IS NOT NULL AND json_valid(d.model_breakdowns)
  GROUP BY COALESCE(d.platform, 'claude'), json_extract(j.value, '$.modelName')
  ORDER BY tokens DESC
  LIMIT ${MODEL_GROUP_LIMIT}`;

export function groupModelUsage(rows: unknown[], perPlatform = MODELS_PER_PLATFORM): ModelUsageSummary {
  const byPlatform = new Map<string, ModelUsage[]>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const model = typeof row.model === 'string' ? row.model : '';
    const totalTokens = Number(row.tokens) || 0;
    if (!model || totalTokens <= 0) continue;
    const usage: ModelUsage = {
      model,
      inputTokens: Number(row.input) || 0,
      outputTokens: Number(row.output) || 0,
      cacheCreationTokens: Number(row.cache_creation) || 0,
      cacheReadTokens: Number(row.cache_read) || 0,
      totalTokens,
      costUsd: Number(row.cost) || 0,
      users: Number(row.users) || 0,
    };
    const platform = String(row.plat);
    const list = byPlatform.get(platform);
    if (list) list.push(usage);
    else byPlatform.set(platform, [usage]);
  }

  const platforms: PlatformModels[] = [...byPlatform.entries()].map(([platform, models]) => {
    models.sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
    return {
      platform,
      totalTokens: models.reduce((sum, m) => sum + m.totalTokens, 0),
      costUsd: models.reduce((sum, m) => sum + m.costUsd, 0),
      modelCount: models.length,
      models: models.slice(0, perPlatform),
    };
  });
  platforms.sort((a, b) => b.totalTokens - a.totalTokens);
  return { platforms, attributedTokens: platforms.reduce((sum, p) => sum + p.totalTokens, 0) };
}

export async function queryModelUsage(db: D1Database, startDate: string): Promise<ModelUsageSummary> {
  const res = await db.prepare(MODEL_USAGE_SQL).bind(startDate).all();
  return groupModelUsage(res.results || []);
}
