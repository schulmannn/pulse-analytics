/**
 * Pure daily/weekly/monthly bucketing helpers for the metric page — extracted so the
 * comparison-window invariant is unit-testable (a silent off-by-one there once dropped the
 * on-chart comparison entirely). No React / no fmt: keys only, formatting stays in the panel.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export type Grain = 'day' | 'week' | 'month';

/** Bucket key for an instant: `YYYY-MM-DD` (day), the Monday of its ISO week, or `YYYY-MM`. */
export function bucketKeyOf(t: number, grain: Grain): string {
  const d = new Date(t);
  if (grain === 'day') return d.toISOString().slice(0, 10);
  if (grain === 'week') {
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 7);
}

/** All bucket keys covering [from..to], in order (day steps / Mondays / first-of-month). */
export function bucketKeysInWindow(fromMs: number, toMs: number, grain: Grain): string[] {
  const keys: string[] = [];
  if (grain === 'month') {
    const d = new Date(fromMs);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() <= toMs) {
      keys.push(d.toISOString().slice(0, 7));
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return keys;
  }
  const step = grain === 'week' ? 7 * DAY_MS : DAY_MS;
  let t = grain === 'week' ? Date.parse(bucketKeyOf(fromMs, 'week')) : fromMs - (fromMs % DAY_MS);
  for (; t <= toMs; t += step) keys.push(bucketKeyOf(t, grain));
  return keys;
}

/** The comparison (previous / year-ago) window for an active [winFrom..winTo].
 *  `prev.to = winFrom - DAY_MS` — a FULL day before the active window, NOT `winFrom - 1`ms:
 *  when winFrom isn't midnight-aligned (winTo = Date.now()) a 1ms gap lands on winFrom's own
 *  calendar day, so the baseline came out one day-bucket LONGER than the active window and the
 *  strict length gate silently dropped the ghost — the on-chart comparison vanished. */
export function comparisonWindow(
  winFrom: number,
  winTo: number,
  mode: 'prev' | 'year',
): { from: number; to: number } {
  const spanMs = winTo - winFrom;
  return mode === 'prev'
    ? { from: winFrom - spanMs - DAY_MS, to: winFrom - DAY_MS }
    : { from: winFrom - 365 * DAY_MS, to: winTo - 365 * DAY_MS };
}

/** Fit a comparison (previous-period) series to the active series length: on odd windows the
 *  baseline can overshoot by a bucket at the tail — drop the extra tail (keep leading buckets
 *  aligned day-for-day); front-pad with zeros if short. */
export function alignGhost(vals: number[], n: number): number[] {
  if (vals.length === n) return vals;
  if (vals.length > n) return vals.slice(0, n);
  return [...new Array(n - vals.length).fill(0), ...vals];
}
