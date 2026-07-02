/**
 * Helpers for the «dd.mm» day labels the API uses in by-day maps (views_by_day, mentions
 * by_day). The labels carry no year, so a naive "parse with the current year" sort breaks
 * across New Year: 28.12 would sort AFTER 03.01. The year is inferred instead: a label month
 * far "ahead" of the current month can only be data from the previous year (analytics data
 * is historical — a genuinely future month never appears beyond a timezone-edge day).
 */

/** Epoch-ms sort key for a «dd.mm» label with year-rollover inference. */
export function ddMmSortKey(label: string, now: Date = new Date()): number {
  const [dayRaw, monthRaw] = label.split('.').map(Number);
  const day = Number.isFinite(dayRaw) ? (dayRaw as number) : 1;
  const month = (Number.isFinite(monthRaw) ? (monthRaw as number) : 1) - 1;
  // Months "ahead" of the current month (0..11). Historical data can't be months in the
  // future, so anything more than ~6 ahead is really the previous year (Dec seen from Jan).
  const monthsAhead = (month - now.getMonth() + 12) % 12;
  const year = now.getFullYear() - (monthsAhead > 6 ? 1 : 0);
  return new Date(year, month, day).getTime();
}

/** Comparator for sorting «dd.mm» labels chronologically across a year boundary. */
export function compareDdMm(a: string, b: string, now: Date = new Date()): number {
  return ddMmSortKey(a, now) - ddMmSortKey(b, now);
}
