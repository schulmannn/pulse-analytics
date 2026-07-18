import { useEffect, useMemo, useState } from 'react';
import type { PagePeriodValue } from './period';
import { usePagePeriod } from './period';

/**
 * The one place MoySklad requests turn the feed top-bar period into wire parameters. Every MS hook
 * serialises through here, so the exact start/end window (inclusive) is honoured uniformly instead
 * of each hook dropping it and sending only `days`.
 *
 * Both a custom range AND a 7/30/90 preset resolve to explicit `from`/`to` local calendar-day keys
 * (YYYY-MM-DD) — the same coordinate system the MS archive/day series and the backend
 * `sinceDay`/`untilDay` use, inclusive of both endpoints. Pinning the preset window in the user's
 * local calendar (not the server's Railway-UTC clock) keeps the current window, its previous equal
 * window, the query key and the densification grid aligned to the same boundaries near midnight.
 * `days` stays as a stable label/fallback; `custom` marks a user-picked range so labels can still
 * say «за N дн.» for a preset. «Всё» (days=0) stays unbounded — no `from`/`to`, no invented previous.
 */
export interface MsPeriod {
  days: number;
  from?: string;
  to?: string;
  /** True only for a user-picked custom range (not a preset expanded to its calendar bounds). */
  custom?: boolean;
}

/** epoch ms → local YYYY-MM-DD (mirror of the sklad panels' localDayKey). */
export function msDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The authoritative MS window from a page period. `null` (outside a feed) → the 30д default.
 *
 * A custom range resolves to its exact inclusive day keys; a 7/30/90 preset resolves to
 * `today-(days-1)…today` in the user's LOCAL calendar (see {@link presetBounds}) so the wire window
 * no longer depends on the server's clock; «Всё» (days=0) stays unbounded. `now` is injectable so
 * unit tests don't depend on the runner's timezone/clock.
 */
export function msPeriod(
  pp: Pick<PagePeriodValue, 'days' | 'range'> | null,
  now: number = Date.now(),
): MsPeriod {
  if (pp?.range) {
    return { days: pp.days, from: msDayKey(pp.range.from), to: msDayKey(pp.range.to), custom: true };
  }
  const days = pp ? pp.days : 30;
  const bounds = presetBounds(days, now);
  return bounds ? { days, from: bounds.from, to: bounds.to } : { days };
}

function shiftDayKey(key: string, offset: number): string {
  const date = dayToDate(key);
  date.setDate(date.getDate() + offset);
  return msDayKey(date.getTime());
}

/**
 * The one pure helper that owns a preset's inclusive calendar bounds: `today-(days-1)…today` in the
 * local calendar, or `null` for «Всё»/non-positive days. `now` is injectable for deterministic tests.
 */
function presetBounds(days: number, now: number): { from: string; to: string } | null {
  if (days <= 0) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const to = msDayKey(today.getTime());
  return { from: shiftDayKey(to, -(days - 1)), to };
}

/** Inclusive calendar bounds actually requested by an MS preset/custom period. */
export function msPeriodBounds(period: MsPeriod, now: number = Date.now()): { from: string; to: string } | null {
  if (period.from && period.to) return { from: period.from, to: period.to };
  return presetBounds(period.days, now);
}

/** Immediately preceding equal inclusive calendar window. «Всё» has no honest predecessor. */
export function msPreviousPeriod(period: MsPeriod, now: number = Date.now()): MsPeriod | null {
  const bounds = msPeriodBounds(period, now);
  if (!bounds) return null;
  const from = dayToDate(bounds.from);
  const to = dayToDate(bounds.to);
  const days = Math.round(
    (Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
      - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86_400_000,
  ) + 1;
  return {
    days: period.days,
    from: shiftDayKey(bounds.from, -days),
    to: shiftDayKey(bounds.from, -1),
  };
}

/**
 * Resolve an MS period as a hook and roll preset bounds at the viewer's next local midnight.
 * Background tabs may throttle the timer, but the callback runs as soon as the tab wakes and then
 * schedules the following boundary. Custom ranges and «Всё» keep the same stable value.
 */
export function useMsResolvedPeriod(
  pp: Pick<PagePeriodValue, 'days' | 'range'> | null,
): MsPeriod {
  const [dayAnchor, setDayAnchor] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNextDay = () => {
      const now = Date.now();
      const next = new Date(now);
      next.setHours(24, 0, 0, 0);
      timer = setTimeout(() => {
        setDayAnchor(Date.now());
        scheduleNextDay();
      }, Math.max(1_000, next.getTime() - now + 100));
    };
    scheduleNextDay();
    return () => clearTimeout(timer);
  }, []);

  return useMemo(
    () => msPeriod(pp, dayAnchor),
    [pp?.days, pp?.range?.from, pp?.range?.to, dayAnchor],
  );
}

/** The page-level MS window as a hook — the shape every sklad panel reads. */
export function useMsPagePeriod(): MsPeriod {
  return useMsResolvedPeriod(usePagePeriod());
}

/** URLSearchParams fragment for an MS request. Any bounded window (custom range OR 7/30/90 preset)
    adds `from`/`to`; `days` is always sent (label/fallback). «Всё» sends only `days=0`. Returns e.g.
    `days=0` or `days=30&from=…&to=…`. */
export function msPeriodQuery(p: MsPeriod): string {
  const q = new URLSearchParams({ days: String(p.days) });
  if (p.from && p.to) {
    q.set('from', p.from);
    q.set('to', p.to);
  }
  return q.toString();
}

/** Stable React-Query cache-key fragment — bounds-aware so it keys on the exact `from`/`to` window
    a request carries (preset or custom), and «Всё» keys on `['d', 0]`. The day keys only roll at the
    user's local midnight, so the key stays stable across renders (no refetch loop). */
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
 * match the request. Any bounded window (custom range OR 7/30/90 preset) carries explicit `from`/`to`
 * and densifies over exactly those keys — the SAME boundaries sent on the wire and keyed in the
 * cache. «Всё» has no bounds, so it spans the archive's own first day…today (caller supplies the
 * first series day). A bare `{ days }` with days>0 (should not occur post-{@link msPeriod}) still
 * falls back to a local `today-(days-1)…today` window rather than dropping the window entirely.
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
