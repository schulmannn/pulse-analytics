import type { PagePeriodValue } from './period';
import { usePagePeriod } from './period';

/**
 * The one place MoySklad requests turn the feed top-bar period into wire parameters. Every MS hook
 * serialises through here, so the exact custom start/end window (inclusive) is honoured uniformly
 * instead of each hook dropping it and sending only `days`.
 *
 * A custom range wins over the preset; `days` is retained as a stable label/fallback. `from`/`to`
 * are local calendar-day keys (YYYY-MM-DD) — the same coordinate system the MS archive/day series
 * and the backend `sinceDay`/`untilDay` use — so the boundary is inclusive of both endpoints.
 */
export interface MsPeriod {
  days: number;
  from?: string;
  to?: string;
}

/** epoch ms → local YYYY-MM-DD (mirror of the sklad panels' localDayKey). */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The authoritative MS window from a page period. `null` (outside a feed) → the 30д default. */
export function msPeriod(pp: PagePeriodValue | null): MsPeriod {
  if (pp?.range) return { days: pp.days, from: dayKey(pp.range.from), to: dayKey(pp.range.to) };
  return { days: pp ? pp.days : 30 };
}

/** The page-level MS window as a hook — the shape every sklad panel reads. */
export function useMsPagePeriod(): MsPeriod {
  return msPeriod(usePagePeriod());
}

/** URLSearchParams fragment for an MS request. Custom range adds `from`/`to`; `days` is always
    sent (label/fallback and preset endpoints). Returns e.g. `days=30` or `days=30&from=…&to=…`. */
export function msPeriodQuery(p: MsPeriod): string {
  const q = new URLSearchParams({ days: String(p.days) });
  if (p.from && p.to) {
    q.set('from', p.from);
    q.set('to', p.to);
  }
  return q.toString();
}

/** Stable React-Query cache-key fragment — range-aware so a preset and a custom window never
    collide, and two different custom windows stay distinct. */
export function msPeriodKey(p: MsPeriod): Array<string | number> {
  return p.from && p.to ? ['r', p.from, p.to] : ['d', p.days];
}

function dayToDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * The inclusive calendar window a panel densifies its day-series over. The server returns only days
 * WITH orders, so the panels backfill the rest of the window with honest zeros — but the window must
 * match the request: a custom range spans `from…to`, a preset spans `today-(days-1)…today`, and «Всё»
 * spans the archive's own first day…today (caller supplies the first series day for that case).
 */
export function msDensifyWindow(p: MsPeriod, firstSeriesDay?: string): { start: Date; end: Date } | null {
  if (p.from && p.to) return { start: dayToDate(p.from), end: dayToDate(p.to) };
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (p.days > 0) {
    return { start: new Date(end.getFullYear(), end.getMonth(), end.getDate() - (p.days - 1)), end };
  }
  // «Всё»: anchor on the archive's earliest returned day (null when the series is empty).
  return firstSeriesDay ? { start: dayToDate(firstSeriesDay), end } : null;
}
