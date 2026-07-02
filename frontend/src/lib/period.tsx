import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type PeriodDays = 7 | 30 | 90 | 0;

/** Inclusive custom date window (epoch ms). When set, it overrides the `days` preset. */
export interface DateRange {
  from: number;
  to: number;
}

interface PeriodContextValue {
  days: PeriodDays;
  setDays: (days: PeriodDays) => void;
  range: DateRange | null;
  setRange: (range: DateRange | null) => void;
  /** True if a date is inside the active window (custom range if set, else the `days` preset). */
  inRange: (dateISO: string | null | undefined) => boolean;
}

const PeriodContext = createContext<PeriodContextValue | null>(null);

const DAY_MS = 24 * 60 * 60 * 1000;
const P_TO_DAYS: Record<string, PeriodDays> = { '7d': 7, '30d': 30, '90d': 90, all: 0 };

/** Parse a YYYY-MM-DD query param into local-midnight epoch ms (null if malformed). */
function parseDayParam(raw: string | null): number | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  const ts = new Date(y!, m! - 1, d!).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Initial period from the URL (?p=7d|30d|90d|all, or ?from&to=YYYY-MM-DD for a shifted /
 * custom window) — a shared link restores the exact window on load. Read synchronously
 * here (plain location.search, no Router needed); writing back is PeriodUrlSync's job.
 */
function initialPeriodFromUrl(): { days: PeriodDays; range: DateRange | null } {
  const fallback = { days: 30 as PeriodDays, range: null };
  if (typeof window === 'undefined') return fallback;
  try {
    const params = new URLSearchParams(window.location.search);
    const from = parseDayParam(params.get('from'));
    const to = parseDayParam(params.get('to'));
    if (from != null && to != null && from <= to) {
      // `to` is inclusive — extend to the end of that day (matches the DateRangePicker).
      return { days: 30, range: { from, to: to + DAY_MS - 1 } };
    }
    const preset = P_TO_DAYS[params.get('p') ?? ''];
    if (preset !== undefined) return { days: preset, range: null };
  } catch {
    /* malformed URL — fall back to the default window */
  }
  return fallback;
}

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(initialPeriodFromUrl);
  const [days, setDaysState] = useState<PeriodDays>(initial.days);
  const [range, setRangeState] = useState<DateRange | null>(initial.range);

  // Picking a preset clears any custom range; picking a range leaves `days` as the fallback.
  const setDays = useCallback((next: PeriodDays) => {
    setRangeState(null);
    setDaysState(next);
  }, []);
  const setRange = useCallback((next: DateRange | null) => {
    setRangeState(next);
  }, []);

  const inRange = useCallback(
    (dateISO: string | null | undefined): boolean => {
      if (range) {
        if (!dateISO) return false;
        const t = Date.parse(dateISO);
        return Number.isFinite(t) && t >= range.from && t <= range.to;
      }
      return inRangeByDays(dateISO, days);
    },
    [range, days],
  );

  const value = useMemo(
    () => ({ days, setDays, range, setRange, inRange }),
    [days, setDays, range, setRange, inRange],
  );

  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

export function usePeriod(): PeriodContextValue {
  const value = useContext(PeriodContext);
  if (!value) throw new Error('usePeriod must be used within PeriodProvider');
  return value;
}

export function tgLimit(days: PeriodDays): number {
  if (days !== 0 && days <= 7) return 30;
  if (days !== 0 && days <= 30) return 60;
  return 100;
}

/** Fetch limit accounting for a custom range (max posts so any window has enough data). */
export function effectiveLimit(days: PeriodDays, range: DateRange | null): number {
  return range ? 100 : tgLimit(days);
}

export function inRangeByDays(dateISO: string | null | undefined, days: PeriodDays): boolean {
  if (days === 0) return true;
  if (!dateISO) return false;
  const timestamp = Date.parse(dateISO);
  return Number.isFinite(timestamp) && timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
}

// ── Per-widget period ──────────────────────────────────────────────────────────────────────
/**
 * The window a single widget card is showing. Distinct from the global {@link usePeriod}
 * (which now serves only the metric-page / report explorers): every chart on a feed reads
 * its OWN period from the nearest {@link WidgetPeriodContext}, seeded from the card's prefs.
 *
 * The default per-widget window is 30д — parity with the old global default, so nothing shifts
 * for a card the user has never touched.
 */
export interface WidgetPeriodValue {
  days: PeriodDays;
  /** True if a date is inside this widget's window (preset only — per-widget custom ranges
      are a noted follow-up). */
  inRange: (dateISO: string | null | undefined) => boolean;
}

export const DEFAULT_WIDGET_DAYS: PeriodDays = 30;

/** The fallback window used when a chart reads its period outside any widget shell (metric
    pages, reports, standalone previews) — a sane 30д so those callers never crash. */
export const WIDGET_PERIOD_FALLBACK: WidgetPeriodValue = {
  days: DEFAULT_WIDGET_DAYS,
  inRange: (dateISO) => inRangeByDays(dateISO, DEFAULT_WIDGET_DAYS),
};

const WidgetPeriodContext = createContext<WidgetPeriodValue | null>(null);

export function WidgetPeriodProvider({
  value,
  children,
}: {
  value: WidgetPeriodValue;
  children: ReactNode;
}) {
  return <WidgetPeriodContext.Provider value={value}>{children}</WidgetPeriodContext.Provider>;
}

/** The nearest widget period, or a 30д fallback when rendered outside a widget shell. */
export function useWidgetPeriod(): WidgetPeriodValue {
  return useContext(WidgetPeriodContext) ?? WIDGET_PERIOD_FALLBACK;
}

/** Build a {@link WidgetPeriodValue} from a bare preset (memo-friendly at the call site). */
export function widgetPeriodValue(days: PeriodDays): WidgetPeriodValue {
  return { days, inRange: (dateISO) => inRangeByDays(dateISO, days) };
}
