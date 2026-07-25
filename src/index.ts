import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  createSessionToken,
  verifySessionToken,
  generateId,
  generateInviteCode,
  generateApiToken,
  hashApiToken,
  getGoogleAuthorizeUrl,
  exchangeGoogleCode,
  getGoogleUser,
  findOrCreateGoogleUser,
  type SessionPayload,
  type GoogleUser,
} from './auth';
import { parseReport } from './parser';
import {
  landingPage,
  loginPage,
  dashboardPage,
  leaderboardPage,
  historyPage,
  uploadPage,
  invitesPage,
  adminPage,
  aboutPage,
  cardPage,
  settingsPage,
  profilePage,
  errorPage,
} from './html';
import { isValidView, isValidDateString, getDateRange, sanitizeSource, slugify, isValidSlug, type ViewType } from './utils';
import { generateCardSvg, type CardData } from './card';
import { generateCardHtml } from './card-png';
import { uploadCardSvg, getCardPngUrl } from './sirv';

type Bindings = {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  ADMIN_EMAIL: string;
  SIRV_CLIENT_ID: string;
  SIRV_CLIENT_SECRET: string;
};

type Variables = {
  user: {
    id: string;
    google_id: string;
    email: string;
    display_name: string;
    avatar_url: string | null;
    is_admin: number;
    invites_remaining: number;
    sharing_enabled: number;
    git_sharing_enabled: number;
    share_slug: string | null;
    fav_tools: string;
  } | null;
  session: SessionPayload | null;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── Middleware: load session ───────────────────────────────────────────────────

app.use('*', async (c, next) => {
  const token = getCookie(c, 'session');
  if (token) {
    const session = await verifySessionToken(token, c.env.SESSION_SECRET);
    if (session) {
      c.set('session', session);
      const user = await c.env.DB.prepare(
        'SELECT id, google_id, email, display_name, avatar_url, is_admin, invites_remaining, sharing_enabled, git_sharing_enabled, share_slug, fav_tools FROM users WHERE id = ?'
      )
        .bind(session.userId)
        .first();
      c.set('user', user as Variables['user']);
    } else {
      c.set('session', null);
      c.set('user', null);
    }
  } else {
    c.set('session', null);
    c.set('user', null);
  }
  await next();
});

// Helper: require auth
function requireAuth(c: any): Response | null {
  if (!c.get('user')) {
    return c.html(errorPage('Unauthorized', 'Please sign in to access this page.'), 401);
  }
  return null;
}

function requireAdmin(c: any): Response | null {
  const user = c.get('user');
  if (!user || !user.is_admin) {
    return c.html(errorPage('Forbidden', 'Admin access required.'), 403);
  }
  return null;
}

async function getTokenUser(c: any): Promise<Variables['user'] | null> {
  const authHeader = c.req.header('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  const tokenHash = await hashApiToken(token);
  const tokenRow = await c.env.DB.prepare(
    'SELECT id, user_id FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL'
  ).bind(tokenHash).first();

  if (!tokenRow) return null;

  await c.env.DB.prepare(
    'UPDATE api_tokens SET last_used_at = datetime(\'now\') WHERE id = ?'
  ).bind((tokenRow as any).id).run();

  const user = await c.env.DB.prepare(
    'SELECT id, google_id, email, display_name, avatar_url, is_admin, invites_remaining, sharing_enabled, git_sharing_enabled, share_slug, fav_tools FROM users WHERE id = ?'
  ).bind((tokenRow as any).user_id).first();

  return user as Variables['user'];
}

function getBaseUrl(c: any): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

function getLastNDates(days: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function computeStreak(values: number[]): number {
  let streak = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] > 0) streak += 1;
    else break;
  }
  return streak;
}

// ─── Pages ──────────────────────────────────────────────────────────────────────

app.get('/about', (c) => {
  return c.html(aboutPage(c.get('user')));
});

app.get('/history', async (c) => {
  const user = c.get('user');
  const viewParam = c.req.query('view') || 'daily';
  const view: ViewType = isValidView(viewParam) ? viewParam : 'daily';

  const today = new Date().toISOString().slice(0, 10);
  const dateParam = c.req.query('date') || today;
  const dateStr = isValidDateString(dateParam) ? dateParam : today;

  // Platform filter
  const platformParam = c.req.query('platform') || '';
  const historyPlatform: string | null = (platformParam === 'claude' || platformParam === 'codex') ? platformParam : null;

  const dateRange = getDateRange(view, dateStr);

  const histBindings: (string)[] = [dateRange.startDate, dateRange.endDate];
  let histPlatformSQL = '';
  if (historyPlatform) {
    histPlatformSQL = 'AND COALESCE(d.platform, ?) = ?';
    histBindings.push('claude', historyPlatform);
  }

  const results = await c.env.DB.prepare(
    `SELECT
      u.display_name,
      u.avatar_url,
      COALESCE(u.share_slug, LOWER(REPLACE(REPLACE(u.display_name, ' ', '-'), '.', ''))) as share_slug,
      COALESCE(SUM(d.cost_usd), 0) as total_cost,
      COALESCE(SUM(d.total_tokens), 0) as total_tokens,
      COALESCE(SUM(d.output_tokens), 0) as total_output_tokens,
      COUNT(DISTINCT d.date) as days_active,
      MAX(d.date) as last_active
    FROM users u
    JOIN daily_usage d ON u.id = d.user_id
    WHERE d.date >= ? AND d.date <= ? ${histPlatformSQL}
    GROUP BY u.id
    HAVING total_cost > 0
    ORDER BY total_cost DESC
    LIMIT 10`
  )
    .bind(...histBindings)
    .all();

  const entries = (results.results || []).map((row: any, i: number) => ({
    rank: i + 1,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    share_slug: row.share_slug || null,
    total_cost: row.total_cost,
    total_tokens: row.total_tokens,
    total_output_tokens: row.total_output_tokens,
    days_active: row.days_active,
    last_active: row.last_active,
    output_per_dollar: 0,
    cache_rate: 0,
    output_ratio: 0,
    meets_efficiency_threshold: false,
  }));

  return c.html(historyPage(view, dateRange, entries, user, historyPlatform));
});

app.get('/login', (c) => {
  const user = c.get('user');
  if (user) return c.redirect('/');
  return c.html(loginPage());
});

app.get('/', async (c) => {
  const user = c.get('user');
  if (!user) {
    // Fetch top 3 for the landing page
    const top3 = await c.env.DB.prepare(
      `SELECT
        u.display_name,
        u.avatar_url,
        COALESCE(u.share_slug, LOWER(REPLACE(REPLACE(u.display_name, ' ', '-'), '.', ''))) as share_slug,
        COALESCE(SUM(d.cost_usd), 0) as total_cost,
        COALESCE(SUM(d.total_tokens), 0) as total_tokens,
        COALESCE(SUM(d.output_tokens), 0) as total_output_tokens,
        COUNT(DISTINCT d.date) as days_active,
        MAX(d.date) as last_active
      FROM users u
      LEFT JOIN daily_usage d ON u.id = d.user_id
      GROUP BY u.id
      HAVING total_cost > 0
      ORDER BY total_cost DESC
      LIMIT 3`
    ).all();

    const entries = (top3.results || []).map((row: any, i: number) => ({
      rank: i + 1,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      share_slug: row.share_slug || null,
      total_cost: row.total_cost,
      total_tokens: row.total_tokens,
      total_output_tokens: row.total_output_tokens,
      days_active: row.days_active,
      last_active: row.last_active,
      output_per_dollar: 0,
      cache_rate: 0,
      output_ratio: 0,
      meets_efficiency_threshold: false,
    }));

    return c.html(landingPage(entries));
  }

  // Get user stats
  const stats = await c.env.DB.prepare(
    `SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COUNT(DISTINCT date) as days_active
    FROM daily_usage WHERE user_id = ?`
  )
    .bind(user.id)
    .first();

  // Get user rank
  const rankResult = await c.env.DB.prepare(
    `SELECT COUNT(*) + 1 as rank FROM (
      SELECT user_id, SUM(cost_usd) as total_cost FROM daily_usage GROUP BY user_id
    ) WHERE total_cost > (
      SELECT COALESCE(SUM(cost_usd), 0) FROM daily_usage WHERE user_id = ?
    )`
  )
    .bind(user.id)
    .first();

  const uploadCount = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM uploads WHERE user_id = ?')
    .bind(user.id)
    .first();

  // Platform breakdown for dashboard
  const dashPlatformStats = await c.env.DB.prepare(
    `SELECT COALESCE(platform, 'claude') as platform,
     COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(total_tokens), 0) as total_tokens,
     COALESCE(SUM(output_tokens), 0) as total_output_tokens, COUNT(DISTINCT date) as days_active
     FROM daily_usage WHERE user_id = ? GROUP BY COALESCE(platform, 'claude')`
  ).bind(user.id).all();

  const dashPlatformBreakdown: Record<string, { total_cost: number; total_tokens: number; total_output_tokens: number; days_active: number }> = {};
  for (const row of (dashPlatformStats.results || []) as any[]) {
    dashPlatformBreakdown[row.platform] = {
      total_cost: row.total_cost,
      total_tokens: row.total_tokens,
      total_output_tokens: row.total_output_tokens,
      days_active: row.days_active,
    };
  }

  return c.html(
    dashboardPage(user, {
      total_cost: (stats as any)?.total_cost ?? 0,
      total_tokens: (stats as any)?.total_tokens ?? 0,
      total_output_tokens: (stats as any)?.total_output_tokens ?? 0,
      days_active: (stats as any)?.days_active ?? 0,
      rank: (rankResult as any)?.rank ?? 0,
      upload_count: (uploadCount as any)?.cnt ?? 0,
      platformBreakdown: dashPlatformBreakdown,
    })
  );
});

app.get('/leaderboard', async (c) => {
  const user = c.get('user');
  const sortParam = c.req.query('sort') || 'cost';
  const sort = ['cost', 'tokens', 'output_per_dollar', 'cache_rate', 'output_ratio'].includes(sortParam) ? sortParam : 'cost';

  // Time filter support (like history page)
  const viewParam = c.req.query('view') || '';
  const view: ViewType | null = isValidView(viewParam) ? viewParam : null;

  // Platform filter (all / claude / codex)
  const platformParam = c.req.query('platform') || '';
  const platform: string | null = (platformParam === 'claude' || platformParam === 'codex') ? platformParam : null;

  let dateRange: ReturnType<typeof getDateRange> | null = null;
  let lbBindings: string[] = [];

  if (view) {
    const today = new Date().toISOString().slice(0, 10);
    const dateParam = c.req.query('date') || today;
    const dateStr = isValidDateString(dateParam) ? dateParam : today;
    dateRange = getDateRange(view, dateStr);
    lbBindings = [dateRange.startDate, dateRange.endDate];
  }

  const whereClauses: string[] = [];
  if (lbBindings.length > 0) whereClauses.push('d.date >= ? AND d.date <= ?');
  if (platform) {
    whereClauses.push('COALESCE(d.platform, ?) = ?');
    lbBindings.push('claude', platform);
  }
  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const query = `SELECT
      u.display_name,
      u.avatar_url,
      COALESCE(u.share_slug, LOWER(REPLACE(REPLACE(u.display_name, ' ', '-'), '.', ''))) as share_slug,
      COALESCE(SUM(d.cost_usd), 0) as total_cost,
      COALESCE(SUM(d.total_tokens), 0) as total_tokens,
      COALESCE(SUM(d.output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(d.cache_read_tokens), 0) as total_cache_read,
      COUNT(DISTINCT d.date) as days_active,
      MAX(d.date) as last_active,
      GROUP_CONCAT(DISTINCT COALESCE(d.platform, 'claude')) as platforms,
      CASE WHEN COALESCE(SUM(d.cost_usd), 0) > 0
        THEN COALESCE(SUM(d.output_tokens), 0) / COALESCE(SUM(d.cost_usd), 1)
        ELSE 0 END as output_per_dollar,
      CASE WHEN COALESCE(SUM(d.total_tokens), 0) > 0
        THEN CAST(COALESCE(SUM(d.cache_read_tokens), 0) AS REAL) / COALESCE(SUM(d.total_tokens), 1)
        ELSE 0 END as cache_rate,
      CASE WHEN (COALESCE(SUM(d.total_tokens), 0) - COALESCE(SUM(d.cache_read_tokens), 0)) > 0
        THEN CAST(COALESCE(SUM(d.output_tokens), 0) AS REAL) / (COALESCE(SUM(d.total_tokens), 0) - COALESCE(SUM(d.cache_read_tokens), 0))
        ELSE 0 END as output_ratio
    FROM users u
    JOIN daily_usage d ON u.id = d.user_id
    ${whereSQL}
    GROUP BY u.id
    HAVING total_cost > 0
    ORDER BY total_cost DESC`;

  const stmt = c.env.DB.prepare(query);
  const results = lbBindings.length > 0
    ? await stmt.bind(...lbBindings).all()
    : await stmt.all();

  const allRows = (results.results || []).map((row: any) => ({
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    share_slug: row.share_slug || null,
    total_cost: row.total_cost,
    total_tokens: row.total_tokens,
    total_output_tokens: row.total_output_tokens,
    days_active: row.days_active,
    last_active: row.last_active,
    output_per_dollar: row.output_per_dollar,
    cache_rate: row.cache_rate,
    output_ratio: row.output_ratio,
    meets_efficiency_threshold: row.total_cost >= 100 && row.days_active >= 10,
    platforms: row.platforms ? String(row.platforms).split(',') : ['claude'],
  }));

  let entries;
  if (sort === 'cost') {
    entries = allRows.map((row: any, i: number) => ({ ...row, rank: i + 1 }));
  } else if (sort === 'tokens') {
    const sorted = [...allRows].sort((a: any, b: any) => b.total_tokens - a.total_tokens);
    entries = sorted.map((row: any, i: number) => ({ ...row, rank: i + 1 }));
  } else {
    const qualified = allRows.filter((r: any) => r.meets_efficiency_threshold);
    const unqualified = allRows.filter((r: any) => !r.meets_efficiency_threshold);
    qualified.sort((a: any, b: any) => b[sort] - a[sort]);
    entries = [
      ...qualified.map((row: any, i: number) => ({ ...row, rank: i + 1 })),
      ...unqualified.map((row: any) => ({ ...row, rank: 0 })),
    ];
  }

  return c.html(leaderboardPage(entries, user, sort, view, dateRange, platform));
});

app.get('/upload', (c) => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;
  return c.html(uploadPage(c.get('user')!));
});

app.get('/invites', async (c) => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;
  const user = c.get('user')!;

  const codes = await c.env.DB.prepare(
    'SELECT code, used_by, use_count, max_uses FROM invite_codes WHERE created_by = ?'
  )
    .bind(user.id)
    .all();

  return c.html(
    invitesPage(
      user,
      (codes.results || []) as any[]
    )
  );
});

app.get('/admin', async (c) => {
  const adminErr = requireAdmin(c);
  if (adminErr) return adminErr;
  const user = c.get('user')!;

  const [userCount, uploadCount, inviteCount, allCodes] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM users').first(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM uploads').first(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM invite_codes').first(),
    c.env.DB.prepare(
      `SELECT ic.code, ic.use_count, ic.max_uses, u.display_name as created_by_name
       FROM invite_codes ic LEFT JOIN users u ON ic.created_by = u.id
       ORDER BY ic.created_at DESC LIMIT 100`
    ).all(),
  ]);

  return c.html(
    adminPage(user, {
      total_users: (userCount as any)?.cnt ?? 0,
      total_uploads: (uploadCount as any)?.cnt ?? 0,
      total_invites: (inviteCount as any)?.cnt ?? 0,
    }, (allCodes.results || []) as any[])
  );
});

// ─── User Profile (public) ───────────────────────────────────────────────────────

app.get('/user/:slug', async (c) => {
  const slug = c.req.param('slug');
  // First try to find by share_slug (for users who have set a custom slug)
  let profileUser = await c.env.DB.prepare(
    'SELECT id, display_name, avatar_url, share_slug, sharing_enabled, fav_tools FROM users WHERE share_slug = ?'
  ).bind(slug).first();

  // If not found by share_slug, try to find by auto-generated slug from display_name
  if (!profileUser) {
    const allUsers = await c.env.DB.prepare(
      'SELECT id, display_name, avatar_url, share_slug, sharing_enabled, fav_tools FROM users'
    ).all();
    profileUser = (allUsers.results || []).find((u: any) => {
      const autoSlug = u.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return autoSlug === slug;
    }) || null;
  }

  if (!profileUser) return c.html(errorPage('Not Found', 'This profile does not exist.'), 404);

  const stats = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(total_tokens), 0) as total_tokens,
     COALESCE(SUM(output_tokens), 0) as total_output_tokens, COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
     COUNT(DISTINCT date) as days_active, MAX(date) as last_active
     FROM daily_usage WHERE user_id = ?`
  ).bind((profileUser as any).id).first();

  const rankResult = await c.env.DB.prepare(
    `SELECT COUNT(*) + 1 as rank FROM (SELECT user_id, SUM(cost_usd) as total_cost FROM daily_usage GROUP BY user_id)
     WHERE total_cost > (SELECT COALESCE(SUM(cost_usd), 0) FROM daily_usage WHERE user_id = ?)`
  ).bind((profileUser as any).id).first();

  // Heatmap: daily data for past 365 days
  const heatmapRows = await c.env.DB.prepare(
    `SELECT date, COALESCE(SUM(cost_usd), 0) as cost, COALESCE(SUM(total_tokens), 0) as tokens, COUNT(*) as sessions
     FROM daily_usage WHERE user_id = ? AND date >= date('now', '-365 days') GROUP BY date`
  ).bind((profileUser as any).id).all();

  const favTools: string[] = (() => {
    try { return JSON.parse((profileUser as any).fav_tools || '[]'); } catch { return []; }
  })();

  const viewer = c.get('user');
  const isOwner = viewer?.id === (profileUser as any).id;

  const gitData = await (async () => {
    const canView = (profileUser as any).git_sharing_enabled === 1 || isOwner;
    if (!canView) return null;

    const userId = (profileUser as any).id;
    const dates = getLastNDates(28);

    const projectRows = await c.env.DB.prepare(
      'SELECT id, repo_name, repo_slug, description, description_override FROM git_projects WHERE user_id = ? ORDER BY repo_name'
    ).bind(userId).all();

  const statsRows = await c.env.DB.prepare(
    'SELECT project_id, date, SUM(commit_count) as commit_count FROM git_daily_stats WHERE user_id = ? AND date >= ? GROUP BY project_id, date'
  ).bind(userId, dates[0]).all();

    const usageRows = await c.env.DB.prepare(
      'SELECT date, COALESCE(SUM(total_tokens), 0) as tokens FROM daily_usage WHERE user_id = ? AND date >= ? GROUP BY date'
    ).bind(userId, dates[0]).all();

    const usageMap = new Map<string, number>();
    (usageRows.results || []).forEach((row: any) => usageMap.set(row.date, row.tokens));

    const statsByProject = new Map<string, Map<string, number>>();
    (statsRows.results || []).forEach((row: any) => {
      if (!statsByProject.has(row.project_id)) statsByProject.set(row.project_id, new Map());
      statsByProject.get(row.project_id)!.set(row.date, row.commit_count);
    });

    const projects = (projectRows.results || []).map((row: any) => {
      const perDay = dates.map((date) => statsByProject.get(row.id)?.get(date) || 0);
      const totalCommits = perDay.reduce((s, v) => s + v, 0);
      const commitsPerDay = totalCommits / dates.length;
      return {
        id: row.id,
        repo_name: row.repo_name,
        repo_slug: row.repo_slug,
        description: row.description,
        description_override: row.description_override,
        per_day: perDay,
        total_commits: totalCommits,
        commits_per_day: commitsPerDay,
        streak: computeStreak(perDay),
      };
    });

    const aggregateSeries = dates.map((date, i) => {
      let sum = 0;
      projects.forEach((p) => { sum += p.per_day[i] || 0; });
      return sum;
    });

    const avgCommitsPerDay = projects.length > 0
      ? projects.reduce((s, p) => s + p.commits_per_day, 0) / projects.length
      : 0;

    return {
      dates,
      projects,
      aggregate: {
        avg_commits_per_day: avgCommitsPerDay,
        streak: computeStreak(aggregateSeries),
        total_commits: aggregateSeries.reduce((s, v) => s + v, 0),
      },
      series: {
        git: aggregateSeries,
        usage: dates.map((date) => usageMap.get(date) || 0),
      },
    };
  })();

  // Platform breakdown stats
  const platformStats = await c.env.DB.prepare(
    `SELECT COALESCE(platform, 'claude') as platform,
     COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(total_tokens), 0) as total_tokens,
     COALESCE(SUM(output_tokens), 0) as total_output_tokens, COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
     COUNT(DISTINCT date) as days_active, MAX(date) as last_active
     FROM daily_usage WHERE user_id = ? GROUP BY COALESCE(platform, 'claude')`
  ).bind((profileUser as any).id).all();

  const platformBreakdown: Record<string, { total_cost: number; total_tokens: number; total_output_tokens: number; days_active: number; last_active: string | null }> = {};
  for (const row of (platformStats.results || []) as any[]) {
    platformBreakdown[row.platform] = {
      total_cost: row.total_cost,
      total_tokens: row.total_tokens,
      total_output_tokens: row.total_output_tokens,
      days_active: row.days_active,
      last_active: row.last_active,
    };
  }

  const totalCost = (stats as any)?.total_cost ?? 0;
  const totalTokens = (stats as any)?.total_tokens ?? 0;
  const totalOutputTokens = (stats as any)?.total_output_tokens ?? 0;
  const totalCacheRead = (stats as any)?.total_cache_read ?? 0;
  const daysActive = (stats as any)?.days_active ?? 0;

  const statsObj = {
    total_cost: totalCost,
    total_tokens: totalTokens,
    total_output_tokens: totalOutputTokens,
    days_active: daysActive,
    rank: (rankResult as any)?.rank ?? 0,
    last_active: (stats as any)?.last_active ?? null,
    output_per_dollar: totalCost > 0 ? totalOutputTokens / totalCost : 0,
    cache_rate: totalTokens > 0 ? totalCacheRead / totalTokens : 0,
    output_ratio: (totalTokens - totalCacheRead) > 0 ? totalOutputTokens / (totalTokens - totalCacheRead) : 0,
    meets_efficiency_threshold: totalCost >= 100 && daysActive >= 10,
    platformBreakdown,
  };

  const isSharingEnabled = (profileUser as any).sharing_enabled === 1;
  const effectiveSlug = (profileUser as any).share_slug || slug;

  // Fire-and-forget: generate full card SVG and upload to Sirv for PNG OG image (only for sharing-enabled users)
  if (isSharingEnabled && c.env.SIRV_CLIENT_ID) {
    const cardData: CardData = {
      displayName: (profileUser as any).display_name,
      avatarUrl: (profileUser as any).avatar_url,
      rank: statsObj.rank,
      totalCost: statsObj.total_cost,
      totalTokens: statsObj.total_tokens,
      totalOutputTokens: statsObj.total_output_tokens,
      daysActive: statsObj.days_active,
      lastActive: statsObj.last_active,
      favTools,
      outputPerDollar: statsObj.meets_efficiency_threshold && statsObj.total_cost > 0 ? statsObj.output_per_dollar : undefined,
    };
    c.executionCtx.waitUntil(
      generateCardSvg(cardData, 'full')
        .then(svg => uploadCardSvg(effectiveSlug, svg, c.env.SIRV_CLIENT_ID, c.env.SIRV_CLIENT_SECRET))
        .catch(() => {})
    );
  }

  return c.html(profilePage(
    { id: (profileUser as any).id, display_name: (profileUser as any).display_name, avatar_url: (profileUser as any).avatar_url, share_slug: effectiveSlug },
    statsObj,
    isSharingEnabled ? favTools : [],
    (heatmapRows.results || []).map((r: any) => ({ date: r.date, cost: r.cost, tokens: r.tokens, sessions: r.sessions })),
    gitData,
    isOwner,
    viewer
  ));
});

// ─── Card Routes (public) ────────────────────────────────────────────────────────

app.get('/card/:slug/image.svg', async (c) => {
  const slug = c.req.param('slug');
  const user = await c.env.DB.prepare(
    'SELECT id, display_name, avatar_url, share_slug, fav_tools FROM users WHERE share_slug = ? AND sharing_enabled = 1'
  ).bind(slug).first();

  if (!user) return c.text('Not Found', 404);

  const stats = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(total_tokens), 0) as total_tokens,
     COALESCE(SUM(output_tokens), 0) as total_output_tokens, COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
     COUNT(DISTINCT date) as days_active, MAX(date) as last_active
     FROM daily_usage WHERE user_id = ?`
  ).bind((user as any).id).first();

  const rankResult = await c.env.DB.prepare(
    `SELECT COUNT(*) + 1 as rank FROM (SELECT user_id, SUM(cost_usd) as total_cost FROM daily_usage GROUP BY user_id)
     WHERE total_cost > (SELECT COALESCE(SUM(cost_usd), 0) FROM daily_usage WHERE user_id = ?)`
  ).bind((user as any).id).first();

  const mode = c.req.query('mode') === 'full' ? 'full' : 'simple';

  const favTools: string[] = (() => {
    try { return JSON.parse((user as any).fav_tools || '[]'); } catch { return []; }
  })();

  const totalCost = (stats as any)?.total_cost ?? 0;
  const totalOutputTokens = (stats as any)?.total_output_tokens ?? 0;
  const daysActive = (stats as any)?.days_active ?? 0;
  const meetsThreshold = totalCost >= 100 && daysActive >= 10;

  const cardData: CardData = {
    displayName: (user as any).display_name,
    avatarUrl: (user as any).avatar_url,
    rank: (rankResult as any)?.rank ?? 0,
    totalCost,
    totalTokens: (stats as any)?.total_tokens ?? 0,
    totalOutputTokens,
    daysActive,
    lastActive: (stats as any)?.last_active ?? null,
    favTools: mode === 'full' ? favTools : undefined,
    outputPerDollar: meetsThreshold && totalCost > 0 ? totalOutputTokens / totalCost : undefined,
  };

  const svg = await generateCardSvg(cardData, mode);

  // Fire-and-forget upload to Sirv for PNG OG images (full mode only)
  if (mode === 'full' && c.env.SIRV_CLIENT_ID) {
    c.executionCtx.waitUntil(
      uploadCardSvg(slug, svg, c.env.SIRV_CLIENT_ID, c.env.SIRV_CLIENT_SECRET).catch(() => {})
    );
  }

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

app.get('/card/:slug/image.png', async (c) => {
  const { ImageResponse } = await import('workers-og');
  const slug = c.req.param('slug');
  const user = await c.env.DB.prepare(
    'SELECT id, display_name, avatar_url, share_slug, fav_tools FROM users WHERE share_slug = ? AND sharing_enabled = 1'
  ).bind(slug).first();

  if (!user) return c.text('Not Found', 404);

  const stats = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(total_tokens), 0) as total_tokens,
     COALESCE(SUM(output_tokens), 0) as total_output_tokens, COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
     COUNT(DISTINCT date) as days_active, MAX(date) as last_active
     FROM daily_usage WHERE user_id = ?`
  ).bind((user as any).id).first();

  const rankResult = await c.env.DB.prepare(
    `SELECT COUNT(*) + 1 as rank FROM (SELECT user_id, SUM(cost_usd) as total_cost FROM daily_usage GROUP BY user_id)
     WHERE total_cost > (SELECT COALESCE(SUM(cost_usd), 0) FROM daily_usage WHERE user_id = ?)`
  ).bind((user as any).id).first();

  const mode = c.req.query('mode') === 'simple' ? 'simple' : 'full';

  const favTools: string[] = (() => {
    try { return JSON.parse((user as any).fav_tools || '[]'); } catch { return []; }
  })();

  const pngTotalCost = (stats as any)?.total_cost ?? 0;
  const pngTotalOutputTokens = (stats as any)?.total_output_tokens ?? 0;
  const pngDaysActive = (stats as any)?.days_active ?? 0;
  const pngMeetsThreshold = pngTotalCost >= 100 && pngDaysActive >= 10;

  const cardData: CardData = {
    displayName: (user as any).display_name,
    avatarUrl: (user as any).avatar_url,
    rank: (rankResult as any)?.rank ?? 0,
    totalCost: pngTotalCost,
    totalTokens: (stats as any)?.total_tokens ?? 0,
    totalOutputTokens: pngTotalOutputTokens,
    daysActive: pngDaysActive,
    lastActive: (stats as any)?.last_active ?? null,
    favTools: mode === 'full' ? favTools : undefined,
    outputPerDollar: pngMeetsThreshold && pngTotalCost > 0 ? pngTotalOutputTokens / pngTotalCost : undefined,
  };

  const html = generateCardHtml(cardData, mode);

  return new ImageResponse(html, {
    width: 1200,
    height: 630,
    format: 'png',
  });
});

app.get('/card/:slug', async (c) => {
  const slug = c.req.param('slug');
  const user = await c.env.DB.prepare(
    'SELECT id, display_name, avatar_url, share_slug FROM users WHERE share_slug = ? AND sharing_enabled = 1'
  ).bind(slug).first();

  if (!user) return c.html(errorPage('Not Found', 'This card does not exist or sharing is disabled.'), 404);

  const stats = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(total_tokens), 0) as total_tokens,
     COALESCE(SUM(output_tokens), 0) as total_output_tokens, COUNT(DISTINCT date) as days_active, MAX(date) as last_active
     FROM daily_usage WHERE user_id = ?`
  ).bind((user as any).id).first();

  const rankResult = await c.env.DB.prepare(
    `SELECT COUNT(*) + 1 as rank FROM (SELECT user_id, SUM(cost_usd) as total_cost FROM daily_usage GROUP BY user_id)
     WHERE total_cost > (SELECT COALESCE(SUM(cost_usd), 0) FROM daily_usage WHERE user_id = ?)`
  ).bind((user as any).id).first();

  const mode = c.req.query('mode') === 'full' ? 'full' : 'simple';

  return c.html(cardPage(
    { display_name: (user as any).display_name, avatar_url: (user as any).avatar_url, share_slug: (user as any).share_slug },
    {
      total_cost: (stats as any)?.total_cost ?? 0,
      total_tokens: (stats as any)?.total_tokens ?? 0,
      total_output_tokens: (stats as any)?.total_output_tokens ?? 0,
      days_active: (stats as any)?.days_active ?? 0,
      rank: (rankResult as any)?.rank ?? 0,
      last_active: (stats as any)?.last_active ?? null,
    },
    mode
  ));
});

// ─── Settings ────────────────────────────────────────────────────────────────────

app.get('/settings', async (c) => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;
  const user = c.get('user')!;
  const shareUrl = user.sharing_enabled && user.share_slug ? `https://ccrank.dev/card/${user.share_slug}` : null;
  const [tokens, gitProjects] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, token_prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
    ).bind(user.id).all(),
    c.env.DB.prepare(
      'SELECT id, repo_name, repo_slug, description, description_override FROM git_projects WHERE user_id = ? ORDER BY repo_name'
    ).bind(user.id).all(),
  ]);

  return c.html(settingsPage(user, shareUrl, (tokens.results || []) as any[], (gitProjects.results || []) as any[]));
});

app.post('/api/settings/sharing', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  let body: { enabled: boolean; slug?: string; favTools?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid request' }, 400);
  }

  const enabled = body.enabled ? 1 : 0;
  let slug = user.share_slug;

  if (enabled) {
    const rawSlug = (body.slug || '').trim().toLowerCase();
    slug = rawSlug || slugify(user.display_name);

    if (!isValidSlug(slug)) {
      return c.json({ ok: false, error: 'Invalid slug. Use lowercase letters, numbers, and hyphens.' }, 400);
    }

    // Check uniqueness
    const existing = await c.env.DB.prepare(
      'SELECT id FROM users WHERE share_slug = ? AND id != ?'
    ).bind(slug, user.id).first();

    if (existing) {
      return c.json({ ok: false, error: 'This slug is already taken. Try another.' }, 400);
    }
  }

  await c.env.DB.prepare(
    'UPDATE users SET sharing_enabled = ?, share_slug = ? WHERE id = ?'
  ).bind(enabled, enabled ? slug : null, user.id).run();

  if (body.favTools !== undefined) {
    const tools = (body.favTools || []).slice(0, 3).map(t => String(t).slice(0, 50));
    await c.env.DB.prepare(
      'UPDATE users SET fav_tools = ? WHERE id = ?'
    ).bind(JSON.stringify(tools), user.id).run();
  }

  return c.json({
    ok: true,
    shareUrl: enabled && slug ? `https://ccrank.dev/card/${slug}` : null,
  });
});

app.post('/api/settings/git-sharing', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  let body: { enabled: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid request' }, 400);
  }

  const enabled = body.enabled ? 1 : 0;
  await c.env.DB.prepare(
    'UPDATE users SET git_sharing_enabled = ? WHERE id = ?'
  ).bind(enabled, user.id).run();

  return c.json({ ok: true });
});

app.get('/api/tokens', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  const tokens = await c.env.DB.prepare(
    'SELECT id, token_prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
  ).bind(user.id).all();

  return c.json({ ok: true, tokens: tokens.results || [] });
});

app.post('/api/tokens/create', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  const token = generateApiToken();
  const tokenHash = await hashApiToken(token);
  const tokenPrefix = token.slice(0, 6);
  const tokenId = generateId();

  await c.env.DB.prepare(
    'INSERT INTO api_tokens (id, user_id, token_hash, token_prefix) VALUES (?, ?, ?, ?)'
  ).bind(tokenId, user.id, tokenHash, tokenPrefix).run();

  return c.json({ ok: true, id: tokenId, token, token_prefix: tokenPrefix });
});

app.post('/api/tokens/revoke', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  let body: { id: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid request' }, 400);
  }

  await c.env.DB.prepare(
    'UPDATE api_tokens SET revoked_at = datetime(\'now\') WHERE id = ? AND user_id = ?'
  ).bind(body.id, user.id).run();

  return c.json({ ok: true });
});

// ─── Auth Routes ────────────────────────────────────────────────────────────────

app.get('/auth/google', (c) => {
  const nonce = generateId();

  // Store a nonce in a cookie so the callback can reject forged requests.
  const stateData = JSON.stringify({ nonce });
  const stateB64 = btoa(stateData);

  setCookie(c, 'oauth_state', stateB64, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600, // 10 minutes
  });

  const redirectUri = `${getBaseUrl(c)}/auth/google/callback`;
  const url = getGoogleAuthorizeUrl(c.env.GOOGLE_CLIENT_ID, redirectUri, stateB64);
  return c.redirect(url);
});

app.get('/auth/google/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const storedState = getCookie(c, 'oauth_state');

  deleteCookie(c, 'oauth_state', { path: '/' });

  if (!code || !stateParam || stateParam !== storedState) {
    return c.html(errorPage('Auth Error', 'Invalid OAuth state. Please try again.'), 400);
  }

  let googleUser: GoogleUser;
  try {
    const redirectUri = `${getBaseUrl(c)}/auth/google/callback`;
    const accessToken = await exchangeGoogleCode(
      code,
      c.env.GOOGLE_CLIENT_ID,
      c.env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );
    googleUser = await getGoogleUser(accessToken);
  } catch (err: any) {
    return c.html(errorPage('Auth Error', err.message || 'Failed to authenticate with Google.'), 400);
  }

  const user = await findOrCreateGoogleUser(
    c.env.DB,
    googleUser,
    c.env.ADMIN_EMAIL
  );

  // Create session
  const token = await createSessionToken(
    { userId: user.id, email: user.email },
    c.env.SESSION_SECRET
  );

  setCookie(c, 'session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60, // 7 days
  });

  return c.redirect('/');
});

app.get('/auth/logout', (c) => {
  deleteCookie(c, 'session', { path: '/' });
  return c.redirect('/');
});

// ─── API Routes ─────────────────────────────────────────────────────────────────

app.post('/api/upload', async (c) => {
  const sessionUser = c.get('user');
  const tokenUser = sessionUser ? null : await getTokenUser(c);
  const user = sessionUser || tokenUser;
  if (!user) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  let body: { json: string; source?: string; platform?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!body.json || typeof body.json !== 'string') {
    return c.json({ ok: false, error: 'Missing "json" field' }, 400);
  }

  const source = sanitizeSource(body.source);

  let report;
  try {
    report = parseReport(body.json);
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 400);
  }

  // Allow explicit platform override from CLI (e.g., ccrank-git sends platform)
  const platformOverride = body.platform === 'codex' ? 'codex' : body.platform === 'claude' ? 'claude' : null;
  if (platformOverride) {
    report.platform = platformOverride;
    for (const entry of report.entries) {
      entry.platform = platformOverride;
    }
  }

  // Clean up legacy rows created by older parser versions when ccusage renamed date -> period.
  await c.env.DB.prepare("DELETE FROM daily_usage WHERE user_id = ? AND source = ? AND date LIKE 'unknown-%'")
    .bind(user.id, source)
    .run();

  // Create upload record
  const uploadId = generateId();
  await c.env.DB.prepare(
    'INSERT INTO uploads (id, user_id, report_type, record_count) VALUES (?, ?, ?, ?)'
  )
    .bind(uploadId, user.id, report.type, report.entries.length)
    .run();

  // Upsert daily usage entries (source + platform tracking)
  const stmt = c.env.DB.prepare(
    `INSERT INTO daily_usage (id, upload_id, user_id, date, source, platform, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, models_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date, source, platform) DO UPDATE SET
       upload_id = excluded.upload_id,
       input_tokens = MAX(excluded.input_tokens, daily_usage.input_tokens),
       output_tokens = MAX(excluded.output_tokens, daily_usage.output_tokens),
       cache_creation_tokens = MAX(excluded.cache_creation_tokens, daily_usage.cache_creation_tokens),
       cache_read_tokens = MAX(excluded.cache_read_tokens, daily_usage.cache_read_tokens),
       total_tokens = MAX(excluded.total_tokens, daily_usage.total_tokens),
       cost_usd = MAX(excluded.cost_usd, daily_usage.cost_usd),
       models_used = excluded.models_used`
  );

  const batch = report.entries.map((entry) =>
    stmt.bind(
      generateId(),
      uploadId,
      user.id,
      entry.date,
      source,
      entry.platform,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheCreationTokens,
      entry.cacheReadTokens,
      entry.totalTokens,
      entry.costUsd,
      JSON.stringify(entry.modelsUsed)
    )
  );

  await c.env.DB.batch(batch);

  return c.json({
    ok: true,
    entries: report.entries.length,
    type: report.type,
    platform: report.platform,
    summary: report.summary,
  });
});

app.post('/api/git/upload', async (c) => {
  const sessionUser = c.get('user');
  const tokenUser = sessionUser ? null : await getTokenUser(c);
  const user = sessionUser || tokenUser;
  if (!user) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  let body: {
    machine?: string;
    projects: {
      repoName: string;
      repoSlug: string;
      description: string;
      descriptionOverride?: boolean;
      days: { date: string; commitCount: number }[];
    }[];
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!Array.isArray(body.projects) || body.projects.length === 0) {
    return c.json({ ok: false, error: 'Missing projects' }, 400);
  }
  if (body.projects.length > 30) {
    return c.json({ ok: false, error: 'Too many projects (max 30)' }, 400);
  }

  const dates = getLastNDates(28);
  const oldestDate = dates[0];
  const machine = sanitizeSource(body.machine);

  for (const project of body.projects) {
    const repoName = String(project.repoName || '').trim().slice(0, 100);
    const repoSlug = String(project.repoSlug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);
    const description = String(project.description || '').trim().slice(0, 200);
    if (!repoName || !repoSlug || !description) {
      return c.json({ ok: false, error: 'Invalid project fields' }, 400);
    }
    if (!Array.isArray(project.days) || project.days.length !== 28) {
      return c.json({ ok: false, error: 'Each project must include 28 daily entries' }, 400);
    }

    for (const day of project.days) {
      if (!isValidDateString(day.date)) {
        return c.json({ ok: false, error: 'Invalid date in daily series' }, 400);
      }
      if (typeof day.commitCount !== 'number' || day.commitCount < 0) {
        return c.json({ ok: false, error: 'Invalid commit count' }, 400);
      }
    }

    let existing = await c.env.DB.prepare(
      'SELECT id, description_override FROM git_projects WHERE user_id = ? AND repo_slug = ?'
    ).bind(user.id, repoSlug).first();

    let projectId: string;
    if (!existing) {
      projectId = generateId();
      await c.env.DB.prepare(
        'INSERT INTO git_projects (id, user_id, repo_name, repo_slug, description, description_override) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(projectId, user.id, repoName, repoSlug, description, project.descriptionOverride ? 1 : 0).run();
    } else {
      projectId = (existing as any).id;
      const override = (existing as any).description_override === 1;
      if (!override || project.descriptionOverride) {
        await c.env.DB.prepare(
          'UPDATE git_projects SET repo_name = ?, description = ?, description_override = ?, updated_at = datetime(\'now\') WHERE id = ?'
        ).bind(repoName, description, project.descriptionOverride ? 1 : 0, projectId).run();
      } else {
        await c.env.DB.prepare(
          'UPDATE git_projects SET repo_name = ?, updated_at = datetime(\'now\') WHERE id = ?'
        ).bind(repoName, projectId).run();
      }
    }

    const stmt = c.env.DB.prepare(
      `INSERT INTO git_daily_stats (id, user_id, project_id, date, machine, commit_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, project_id, date, machine) DO UPDATE SET commit_count = excluded.commit_count`
    );

    const batch = project.days.map((day) =>
      stmt.bind(generateId(), user.id, projectId, day.date, machine, day.commitCount)
    );

    await c.env.DB.batch(batch);
  }

  await c.env.DB.prepare(
    'DELETE FROM git_daily_stats WHERE user_id = ? AND date < ?'
  ).bind(user.id, oldestDate).run();

  return c.json({ ok: true, projects: body.projects.length });
});

app.post('/api/git/projects/update', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  let body: { projectId: string; description: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid request' }, 400);
  }

  const description = String(body.description || '').trim().slice(0, 200);
  if (!body.projectId || !description) {
    return c.json({ ok: false, error: 'Missing project or description' }, 400);
  }

  await c.env.DB.prepare(
    'UPDATE git_projects SET description = ?, description_override = 1, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?'
  ).bind(description, body.projectId, user.id).run();

  return c.json({ ok: true });
});

app.post('/api/git/feedback', async (c) => {
  let body: { userId: string; rating: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid request' }, 400);
  }

  if (!body.userId || (body.rating !== 1 && body.rating !== -1)) {
    return c.json({ ok: false, error: 'Invalid feedback' }, 400);
  }

  const viewer = c.get('user');
  await c.env.DB.prepare(
    'INSERT INTO git_feedback (id, user_id, viewer_id, rating) VALUES (?, ?, ?, ?)'
  ).bind(generateId(), body.userId, viewer?.id || null, body.rating).run();

  return c.json({ ok: true });
});

app.get('/api/leaderboard', async (c) => {
  const platformFilter = c.req.query('platform');
  const validPlatform = platformFilter === 'claude' || platformFilter === 'codex' ? platformFilter : null;

  const apiLbBindings: string[] = [];
  let apiPlatformSQL = '';
  if (validPlatform) {
    apiPlatformSQL = 'WHERE COALESCE(d.platform, ?) = ?';
    apiLbBindings.push('claude', validPlatform);
  }

  const apiLbStmt = c.env.DB.prepare(
    `SELECT
      u.id,
      u.display_name,
      u.avatar_url,
      CASE WHEN u.sharing_enabled = 1 THEN u.share_slug ELSE NULL END as share_slug,
      COALESCE(SUM(d.cost_usd), 0) as total_cost,
      COALESCE(SUM(d.total_tokens), 0) as total_tokens,
      COALESCE(SUM(d.output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(d.cache_read_tokens), 0) as total_cache_read,
      COUNT(DISTINCT d.date) as days_active,
      MAX(d.date) as last_active,
      GROUP_CONCAT(DISTINCT COALESCE(d.platform, 'claude')) as platforms,
      CASE WHEN COALESCE(SUM(d.cost_usd), 0) > 0
        THEN COALESCE(SUM(d.output_tokens), 0) / COALESCE(SUM(d.cost_usd), 1)
        ELSE 0 END as output_per_dollar,
      CASE WHEN COALESCE(SUM(d.total_tokens), 0) > 0
        THEN CAST(COALESCE(SUM(d.cache_read_tokens), 0) AS REAL) / COALESCE(SUM(d.total_tokens), 1)
        ELSE 0 END as cache_rate,
      CASE WHEN (COALESCE(SUM(d.total_tokens), 0) - COALESCE(SUM(d.cache_read_tokens), 0)) > 0
        THEN CAST(COALESCE(SUM(d.output_tokens), 0) AS REAL) / (COALESCE(SUM(d.total_tokens), 0) - COALESCE(SUM(d.cache_read_tokens), 0))
        ELSE 0 END as output_ratio
    FROM users u
    LEFT JOIN daily_usage d ON u.id = d.user_id
    ${apiPlatformSQL}
    GROUP BY u.id
    HAVING total_cost > 0
    ORDER BY total_cost DESC`
  );

  const results = apiLbBindings.length > 0
    ? await apiLbStmt.bind(...apiLbBindings).all()
    : await apiLbStmt.all();

  return c.json({
    ok: true,
    entries: (results.results || []).map((row: any, i: number) => ({
      rank: i + 1,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      share_slug: row.share_slug || null,
      total_cost: row.total_cost,
      total_tokens: row.total_tokens,
      total_output_tokens: row.total_output_tokens,
      output_per_dollar: row.output_per_dollar,
      cache_rate: row.cache_rate,
      output_ratio: row.output_ratio,
      days_active: row.days_active,
      last_active: row.last_active,
      platforms: row.platforms ? String(row.platforms).split(',') : ['claude'],
    })),
  });
});

app.get('/api/me', async (c) => {
  const sessionUser = c.get('user');
  const tokenUser = sessionUser ? null : await getTokenUser(c);
  const user = sessionUser || tokenUser;
  if (!user) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  const stats = await c.env.DB.prepare(
    `SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COUNT(DISTINCT date) as days_active
    FROM daily_usage WHERE user_id = ?`
  )
    .bind(user.id)
    .first();

  // Platform breakdown
  const mePlatformStats = await c.env.DB.prepare(
    `SELECT COALESCE(platform, 'claude') as platform,
     COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(total_tokens), 0) as total_tokens,
     COALESCE(SUM(output_tokens), 0) as total_output_tokens, COUNT(DISTINCT date) as days_active
     FROM daily_usage WHERE user_id = ? GROUP BY COALESCE(platform, 'claude')`
  ).bind(user.id).all();

  const mePlatformBreakdown: Record<string, any> = {};
  for (const row of (mePlatformStats.results || []) as any[]) {
    mePlatformBreakdown[row.platform] = {
      total_cost: row.total_cost,
      total_tokens: row.total_tokens,
      total_output_tokens: row.total_output_tokens,
      days_active: row.days_active,
    };
  }

  return c.json({
    ok: true,
    user: {
      display_name: user.display_name,
      email: user.email,
      avatar_url: user.avatar_url,
    },
    stats,
    platformBreakdown: mePlatformBreakdown,
  });
});

app.get('/api/me/usage', async (c) => {
  const sessionUser = c.get('user');
  const tokenUser = sessionUser ? null : await getTokenUser(c);
  const user = sessionUser || tokenUser;
  if (!user) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  const viewParam = c.req.query('view') || 'daily';
  const view: ViewType = isValidView(viewParam) ? viewParam : 'daily';
  const today = new Date().toISOString().slice(0, 10);
  const dateParam = c.req.query('date') || today;
  const dateStr = isValidDateString(dateParam) ? dateParam : today;
  const dateRange = getDateRange(view, dateStr);

  const stats = await c.env.DB.prepare(
    `SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COUNT(DISTINCT date) as days_active,
      MAX(date) as last_active
    FROM daily_usage
    WHERE user_id = ? AND date >= ? AND date <= ?`
  ).bind(user.id, dateRange.startDate, dateRange.endDate).first();

  const totalCost = Number((stats as any)?.total_cost ?? 0);
  let rank = 0;
  if (totalCost > 0) {
    const rankResult = await c.env.DB.prepare(
      `SELECT COUNT(*) + 1 as rank FROM (
        SELECT user_id, SUM(cost_usd) as total_cost
        FROM daily_usage
        WHERE date >= ? AND date <= ?
        GROUP BY user_id
        HAVING total_cost > 0
      )
      WHERE total_cost > ?`
    ).bind(dateRange.startDate, dateRange.endDate, totalCost).first();
    rank = Number((rankResult as any)?.rank ?? 0);
  }

  const leaderboardUrl = `${getBaseUrl(c)}/leaderboard?sort=cost&view=${view}&date=${dateRange.startDate}`;

  return c.json({
    ok: true,
    user: {
      display_name: user.display_name,
      email: user.email,
      avatar_url: user.avatar_url,
    },
    stats: {
      date: dateStr,
      start_date: dateRange.startDate,
      end_date: dateRange.endDate,
      total_cost: totalCost,
      total_tokens: Number((stats as any)?.total_tokens ?? 0),
      total_output_tokens: Number((stats as any)?.total_output_tokens ?? 0),
      total_cache_read: Number((stats as any)?.total_cache_read ?? 0),
      days_active: Number((stats as any)?.days_active ?? 0),
      last_active: (stats as any)?.last_active ?? null,
      rank,
    },
    leaderboard_url: leaderboardUrl,
  });
});

app.post('/api/invites/create', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  if (user.invites_remaining <= 0) {
    return c.json({ ok: false, error: 'No invites remaining' }, 400);
  }

  const code = generateInviteCode();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO invite_codes (code, created_by) VALUES (?, ?)').bind(code, user.id),
    c.env.DB.prepare('UPDATE users SET invites_remaining = invites_remaining - 1 WHERE id = ?').bind(user.id),
  ]);

  return c.json({ ok: true, code });
});

app.post('/api/admin/invites', async (c) => {
  const user = c.get('user');
  if (!user || !user.is_admin) return c.json({ ok: false, error: 'Forbidden' }, 403);

  let body: { count?: number; maxUses?: number };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const count = Math.min(Math.max(body.count || 5, 1), 50);
  const maxUses = Math.min(Math.max(body.maxUses || 1, 1), 100);

  const stmts = [];
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = generateInviteCode();
    codes.push(code);
    stmts.push(
      c.env.DB.prepare('INSERT INTO invite_codes (code, created_by, max_uses) VALUES (?, ?, ?)').bind(
        code,
        user.id,
        maxUses
      )
    );
  }

  await c.env.DB.batch(stmts);
  return c.json({ ok: true, codes });
});

// ─── 404 ────────────────────────────────────────────────────────────────────────

app.notFound((c) => {
  return c.html(errorPage('Not Found', 'The page you are looking for does not exist.', c.get('user')), 404);
});

export default app;
