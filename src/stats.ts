/**
 * Pure helpers for usage streaks and daily rank deltas.
 * No I/O, no framework — fully unit-testable.
 */

const DAY_MS = 86_400_000;

function toUTCMidnight(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00Z').getTime();
}

function toDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Streaks over YYYY-MM-DD day strings (days having any usage).
 *
 * `current` counts consecutive days ending today — or yesterday, when today
 * has no usage yet (a streak stays alive until a full calendar day is missed).
 * `longest` is the longest run of consecutive days ever recorded.
 */
export function computeStreak(dates: string[], today: string): { current: number; longest: number } {
  const set = new Set(dates);

  let anchor = today;
  if (!set.has(anchor)) anchor = toDateString(toUTCMidnight(today) - DAY_MS);

  let current = 0;
  for (let t = toUTCMidnight(anchor); set.has(toDateString(t)); t -= DAY_MS) {
    current += 1;
  }

  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let prevMs: number | null = null;
  for (const date of sorted) {
    const ms = toUTCMidnight(date);
    run = prevMs !== null && ms - prevMs === DAY_MS ? run + 1 : 1;
    if (run > longest) longest = run;
    prevMs = ms;
  }

  return { current, longest };
}

/**
 * Positive means improved (yesterday_rank - today_rank).
 * NULL when either day has no rank (no usage that day).
 */
export function computeRankDelta(rankToday: number | null, rankYesterday: number | null): number | null {
  if (rankToday === null || rankYesterday === null) return null;
  return rankYesterday - rankToday;
}
