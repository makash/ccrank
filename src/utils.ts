/**
 * Shared utility functions and types for the Claude Leaderboard application.
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
  is_admin: number;
  invites_remaining: number;
  sharing_enabled: number;
  git_sharing_enabled: number;
  share_slug: string | null;
  fav_tools: string; // JSON array of up to 3 strings
}

export interface LeaderboardEntry {
  rank: number;
  display_name: string;
  avatar_url: string | null;
  total_cost: number;
  total_tokens: number;
  total_output_tokens: number;
  days_active: number;
  last_active: string | null;
  share_slug?: string | null;
  output_per_dollar: number;
  cache_rate: number;
  output_ratio: number;
  meets_efficiency_threshold: boolean;
  platforms?: string[];
}

export type SortKey = 'cost' | 'tokens' | 'output_per_dollar' | 'cache_rate' | 'output_ratio';

export type Platform = 'claude' | 'codex' | 'kimi';

export type ViewType = 'daily' | 'weekly' | 'monthly';

export interface DateRange {
  startDate: string;
  endDate: string;
  label: string;
  prevDate: string;
  nextDate: string;
  isCurrentPeriod: boolean;
}

// ─── Formatting ─────────────────────────────────────────────────────────────────

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

export function formatCost(n: number): string {
  return '$' + n.toFixed(2);
}

export function formatEfficiency(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M';
  if (value >= 1_000) return (value / 1_000).toFixed(1) + 'K';
  return Math.round(value).toString();
}

export function formatPercent(value: number): string {
  return (value * 100).toFixed(1) + '%';
}

export function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Title system ───────────────────────────────────────────────────────────────

export function getTitle(tokens: number): { label: string; color: string } {
  if (tokens >= 500_000_000) return { label: 'Token Maximalist', color: '#f59e0b' };
  if (tokens >= 100_000_000) return { label: 'Token Whale', color: '#8b5cf6' };
  if (tokens >= 50_000_000) return { label: 'Power User', color: '#06b6d4' };
  if (tokens >= 10_000_000) return { label: 'Practitioner', color: '#10b981' };
  return { label: 'Apprentice', color: '#6b7280' };
}

// ─── Validation ─────────────────────────────────────────────────────────────────

export function isValidView(view: string | undefined): view is ViewType {
  return view === 'daily' || view === 'weekly' || view === 'monthly';
}

export function isValidPlatform(platform: string | undefined): platform is Platform {
  return platform === 'claude' || platform === 'codex' || platform === 'kimi';
}

export function isValidDateString(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + 'T00:00:00Z');
  if (isNaN(parsed.getTime())) return false;
  // Verify roundtrip to catch invalid dates like 2026-02-30
  return parsed.toISOString().startsWith(date);
}

export function sanitizeSource(input: string | undefined): string {
  if (!input) return 'default';
  const cleaned = input.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
  return cleaned || 'default';
}

// ─── Slug helpers ───────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'user';
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/.test(slug) || /^[a-z0-9]$/.test(slug);
}

// ─── Date ranges for time travel ────────────────────────────────────────────────

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function getDateRange(view: ViewType, dateStr: string): DateRange {
  const date = new Date(dateStr + 'T00:00:00Z');

  if (view === 'daily') {
    const prev = new Date(date);
    prev.setUTCDate(prev.getUTCDate() - 1);
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + 1);
    const today = toDateString(new Date());

    return {
      startDate: dateStr,
      endDate: dateStr,
      label: formatDateLabel(date),
      prevDate: toDateString(prev),
      nextDate: toDateString(next),
      isCurrentPeriod: dateStr === today,
    };
  }

  if (view === 'weekly') {
    // ISO week: Monday start
    const day = date.getUTCDay();
    const monday = new Date(date);
    monday.setUTCDate(monday.getUTCDate() - ((day + 6) % 7));
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);

    const prevMonday = new Date(monday);
    prevMonday.setUTCDate(prevMonday.getUTCDate() - 7);
    const nextMonday = new Date(monday);
    nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);

    const now = new Date();
    const nowDay = now.getUTCDay();
    const currentMonday = new Date(now);
    currentMonday.setUTCDate(currentMonday.getUTCDate() - ((nowDay + 6) % 7));

    return {
      startDate: toDateString(monday),
      endDate: toDateString(sunday),
      label: `Week of ${formatDateLabel(monday)}`,
      prevDate: toDateString(prevMonday),
      nextDate: toDateString(nextMonday),
      isCurrentPeriod: toDateString(monday) === toDateString(currentMonday),
    };
  }

  // monthly
  const startOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const endOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  const prevMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));

  const now = new Date();
  const isCurrentMonth = date.getUTCFullYear() === now.getUTCFullYear() && date.getUTCMonth() === now.getUTCMonth();

  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  return {
    startDate: toDateString(startOfMonth),
    endDate: toDateString(endOfMonth),
    label: `${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`,
    prevDate: toDateString(prevMonth),
    nextDate: toDateString(nextMonth),
    isCurrentPeriod: isCurrentMonth,
  };
}

function formatDateLabel(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}
