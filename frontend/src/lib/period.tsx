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

/** Start/end helpers use calendar operations, so a picked day stays exact across DST changes. */
export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function endOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function shiftLocalDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/**
 * API archive rows use bare YYYY-MM-DD calendar keys, while posts/graphs use real instants.
 * Date.parse treats a bare key as UTC midnight and shifts the selected day for viewers west/east
 * of UTC. Preserve day keys as local calendar midnights; retain instant semantics for full ISO.
 */
export function periodDateTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return Date.parse(value);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return Number.NaN;
  }
  return date.getTime();
}

/** Parse a YYYY-MM-DD query param into local-midnight epoch ms (null if malformed). */
function parseDayParam(raw: string | null): number | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ts = periodDateTimestamp(raw);
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
      return { days: 30, range: { from, to: endOfLocalDay(to) } };
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
        const t = periodDateTimestamp(dateISO);
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
  const timestamp = periodDateTimestamp(dateISO);
  return Number.isFinite(timestamp) && timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
}

// ── Per-widget period ──────────────────────────────────────────────────────────────────────
/**
 * The window a single widget card is showing. Distinct from the global {@link usePeriod}
 * (which now serves only the metric-page / report explorers): every chart reads the resolved
 * window from the nearest {@link WidgetPeriodContext}. Feed cards resolve to the page period;
 * standalone/Home cards resolve to their own prefs.
 *
 * The default per-widget window is 30д — parity with the old global default, so nothing shifts
 * for a card the user has never touched.
 */
export interface WidgetPeriodValue {
  days: PeriodDays;
  /** Page-level custom date window when one is active; `null` means the `days` preset applies.
      Series that window by calendar date (graphs) read this to honour a custom range the `days`
      fallback can't express. */
  range: DateRange | null;
  /** True if a date is inside this widget's active preset or page-level custom range. */
  inRange: (dateISO: string | null | undefined) => boolean;
}

export const DEFAULT_WIDGET_DAYS: PeriodDays = 30;

/** The fallback window used when a chart reads its period outside any widget shell (metric
    pages, reports, standalone previews) — a sane 30д so those callers never crash. */
export const WIDGET_PERIOD_FALLBACK: WidgetPeriodValue = {
  days: DEFAULT_WIDGET_DAYS,
  range: null,
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

/** Build a {@link WidgetPeriodValue} from a preset and optional page-level custom range. */
export function widgetPeriodValue(days: PeriodDays, range: DateRange | null = null): WidgetPeriodValue {
  return {
    days,
    range,
    inRange: (dateISO) => {
      if (!range) return inRangeByDays(dateISO, days);
      if (!dateISO) return false;
      const timestamp = periodDateTimestamp(dateISO);
      return Number.isFinite(timestamp) && timestamp >= range.from && timestamp <= range.to;
    },
  };
}

/** Inclusive epoch-ms window. `null` is the unbounded «Всё» period. */
export interface CalendarWindow {
  from: number;
  to: number;
}

/** Calendar window for a preset. The boundary matches {@link inRangeByDays}. */
export function calendarWindowForDays(days: number, now: number = Date.now()): CalendarWindow | null {
  return days === 0 ? null : { from: now - days * DAY_MS, to: now };
}

/** Exact custom range when present, otherwise the widget's preset window. */
export function calendarWindowForPeriod(
  period: Pick<WidgetPeriodValue, 'days' | 'range'>,
  now: number = Date.now(),
): CalendarWindow | null {
  return period.range
    ? { from: period.range.from, to: period.range.to }
    : calendarWindowForDays(period.days, now);
}

export interface CalendarRows<T> {
  current: T[];
  /** Immediately preceding equal calendar window; null when the archive cannot cover it. */
  previous: T[] | null;
  /** False means the input has no usable dates, so bounded filtering cannot be applied honestly. */
  windowable: boolean;
}

/**
 * Select current and immediately preceding equal windows from dated rows. Full local-day picker
 * ranges shift by a calendar-day count (DST-safe); rolling windows use equal inclusive millisecond
 * spans. With no usable dates a bounded caller gets the original rows and `windowable=false` rather
 * than a fabricated empty series.
 */
export function splitCalendarRows<T>(
  rows: T[],
  window: CalendarWindow | null,
  timestampOf: (row: T, index: number) => number,
): CalendarRows<T> {
  if (window == null) return { current: rows, previous: null, windowable: true };

  const dated = rows.flatMap((row, index) => {
    const timestamp = Number(timestampOf(row, index));
    return Number.isFinite(timestamp) ? [{ row, timestamp }] : [];
  });
  if (dated.length === 0) return { current: rows, previous: null, windowable: false };
  if (!Number.isFinite(window.from) || !Number.isFinite(window.to) || window.to < window.from) {
    return { current: [], previous: null, windowable: true };
  }

  const current = dated
    .filter(({ timestamp }) => timestamp >= window.from && timestamp <= window.to)
    .map(({ row }) => row);
  const isCalendarRange = startOfLocalDay(window.from) === window.from && endOfLocalDay(window.to) === window.to;
  const fromDay = new Date(window.from);
  const toDay = new Date(window.to);
  const calendarDays = Math.round(
    (Date.UTC(toDay.getFullYear(), toDay.getMonth(), toDay.getDate())
      - Date.UTC(fromDay.getFullYear(), fromDay.getMonth(), fromDay.getDate())) / DAY_MS,
  ) + 1;
  const span = window.to - window.from + 1;
  const previousFrom = isCalendarRange
    ? shiftLocalDays(window.from, -calendarDays)
    : window.from - span;
  const earliest = Math.min(...dated.map(({ timestamp }) => timestamp));
  const previous =
    earliest <= previousFrom
      ? dated
          .filter(({ timestamp }) => timestamp >= previousFrom && timestamp < window.from)
          .map(({ row }) => row)
      : null;

  return { current, previous, windowable: true };
}

/** Feed pages own one authoritative period; standalone/Home cards keep their saved period. */
export function resolveRequestedWidgetDays(
  pageDays: PeriodDays | null | undefined,
  widgetDays: PeriodDays | undefined,
): PeriodDays {
  return pageDays ?? widgetDays ?? DEFAULT_WIDGET_DAYS;
}

// ── Page period (feed header) ────────────────────────────────────────────────────────────────
/**
 * A feed-level period chosen in the page header (the Обзор/Аналитика header chips — TG and IG feeds
 * alike). It is the authoritative window for every card in that feed, so one header change always
 * re-windows the whole page. `null` outside a feed that provides one (Home board, metric pages):
 * there every card keeps its saved period or falls back to {@link DEFAULT_WIDGET_DAYS}.
 *
 * `range` is a custom date window on top of the preset. Both TG and IG headers expose it; picking a
 * preset clears the range, exactly like the global {@link PeriodProvider}.
 */
export interface PagePeriodValue {
  days: PeriodDays;
  setDays: (days: PeriodDays) => void;
  range: DateRange | null;
  setRange: (range: DateRange | null) => void;
}

const PagePeriodContext = createContext<PagePeriodValue | null>(null);

export function PagePeriodProvider({
  children,
  initialDays = DEFAULT_WIDGET_DAYS,
}: {
  children: ReactNode;
  initialDays?: PeriodDays;
}) {
  const [days, setDaysState] = useState<PeriodDays>(initialDays);
  const [range, setRangeState] = useState<DateRange | null>(null);
  const setDays = useCallback((next: PeriodDays) => {
    setRangeState(null);
    setDaysState(next);
  }, []);
  const setRange = useCallback((next: DateRange | null) => setRangeState(next), []);
  const value = useMemo(() => ({ days, setDays, range, setRange }), [days, setDays, range, setRange]);
  return <PagePeriodContext.Provider value={value}>{children}</PagePeriodContext.Provider>;
}

/** The feed header's page period, or null when no feed provides one (Home / metric pages). */
export function usePagePeriod(): PagePeriodValue | null {
  return useContext(PagePeriodContext);
}

// ── Channel recency → auto-widen an empty window ─────────────────────────────────────────────
/**
 * The current channel's newest data timestamp (epoch ms), or null when unknown. Provided by the
 * feed root (which has the channel's posts + history) and read by every widget card. It exists to
 * kill a confusing empty state: a just-connected / dormant channel whose posts are all old renders
 * «0» under a 7д/30д window and looks broken. When the requested window holds no data but a wider
 * one does, the card widens to the smallest window that DOES — so numbers show instead of a blank.
 */
const ChannelRecencyContext = createContext<number | null>(null);

export function ChannelRecencyProvider({ value, children }: { value: number | null; children: ReactNode }) {
  return <ChannelRecencyContext.Provider value={value}>{children}</ChannelRecencyContext.Provider>;
}

/** The channel's newest-data timestamp (ms), or null outside a provider / when the channel is empty. */
export function useChannelRecency(): number | null {
  return useContext(ChannelRecencyContext);
}

/** True if the channel's latest data falls inside a `days` window (0 = «Всё» ⇒ true given any data). */
export function hasDataWithin(latestDataMs: number | null, days: PeriodDays, now: number = Date.now()): boolean {
  if (latestDataMs == null) return false;
  if (days === 0) return true;
  return latestDataMs >= now - days * DAY_MS;
}

/** Smallest preset whose window still contains the channel's newest data; «Всё» (0) once the newest
    data is older than 90д. Falls back to the plain default when recency is unknown. */
export function recommendPeriod(latestDataMs: number | null, now: number = Date.now()): PeriodDays {
  if (latestDataMs == null) return DEFAULT_WIDGET_DAYS;
  const age = now - latestDataMs;
  if (age <= 7 * DAY_MS) return 7;
  if (age <= 30 * DAY_MS) return 30;
  if (age <= 90 * DAY_MS) return 90;
  return 0;
}

/** The window a card actually shows: the requested one if it holds data, else widened to the
    smallest window that does. A no-op (returns `requested`) when recency is unknown — so nothing
    changes outside the feed, or for a channel with recent data. */
export function resolveEffectivePeriod(requested: PeriodDays, latestDataMs: number | null, now: number = Date.now()): PeriodDays {
  if (latestDataMs == null) return requested;
  if (requested === 0 || hasDataWithin(latestDataMs, requested, now)) return requested;
  return recommendPeriod(latestDataMs, now);
}
