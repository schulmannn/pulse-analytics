import type { HistoryData } from '@/api/schemas';

const DAY_MS = 86_400_000;

export interface Freshness {
  /** Bare relative part — "сегодня" / "вчера" / "N дн. назад". Consumers compose the
      surrounding copy ("обновлено {label}", "последний сбор {label}") exactly once. */
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

/** Newest data timestamp (epoch ms) across a channel's posts and daily archive, or null when it has
    neither. Feeds the per-widget period auto-widening (see resolveEffectivePeriod) so a channel whose
    latest post/history is months old doesn't render blank under a short window. */
export function latestDataMs(
  posts?: ReadonlyArray<{ date?: string | null }> | null,
  history?: HistoryData | null,
): number | null {
  let latest: number | null = null;
  for (const p of posts ?? []) {
    const t = p.date ? Date.parse(p.date) : NaN;
    if (Number.isFinite(t)) latest = latest === null ? t : Math.max(latest, t);
  }
  const day = latestHistoryDay(history);
  if (day) {
    const t = Date.parse(`${day}T00:00:00`);
    if (Number.isFinite(t)) latest = latest === null ? t : Math.max(latest, t);
  }
  return latest;
}

/**
 * Human relative-freshness label from the newest archived day. The archive is daily, so
 * granularity is день — we say сегодня / вчера / N дн. назад rather than inventing hours.
 * Returns the BARE relative part (no leading "обновлено" — every consumer prepends its own
 * verb once, which previously doubled into "обновлено обновлено сегодня"). Returns null when
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

  return { label: when, stale: diffDays >= 2 };
}
