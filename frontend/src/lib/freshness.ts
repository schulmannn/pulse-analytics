import type { HistoryData } from '@/api/schemas';

const DAY_MS = 86_400_000;

export interface Freshness {
  label: string;
  /** True when the newest archived day is ≥2 days old — surfaced as a warning tone. */
  stale: boolean;
}

/** Newest "YYYY-MM-DD" day present in the archive (rows are not guaranteed sorted). */
export function latestHistoryDay(history?: HistoryData | null): string | null {
  const rows = history?.rows ?? [];
  let latest: string | null = null;
  for (const row of rows) {
    if (row.day && (latest === null || row.day > latest)) latest = row.day;
  }
  return latest;
}

/**
 * Human "обновлено …" label from the newest archived day. The archive is daily, so granularity
 * is день — we say сегодня / вчера / N дн. назад rather than inventing hours. Returns null when
 * there's nothing archived yet (caller then shows a neutral subtitle).
 */
export function freshness(latestDay: string | null, nowMs: number): Freshness | null {
  if (!latestDay) return null;
  const last = Date.parse(`${latestDay}T00:00:00`);
  if (!Number.isFinite(last)) return null;
  const now = new Date(nowMs);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.round((todayStart - last) / DAY_MS);

  let when: string;
  if (diffDays <= 0) when = 'сегодня';
  else if (diffDays === 1) when = 'вчера';
  else when = `${diffDays} дн. назад`;

  return { label: `обновлено ${when}`, stale: diffDays >= 2 };
}
