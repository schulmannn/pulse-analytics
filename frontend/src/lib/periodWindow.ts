/**
 * Окно периода на клиенте — одно определение (U01, клиентская половина; серверная —
 * server/domain/period.js). Чистый модуль: без React, роутера и api/* — его тянет каждый маршрут
 * через lib/period и lib/msPeriod, поэтому он обязан оставаться лёгким.
 *
 * Здесь живут:
 *  - PERIOD_PRESETS — единственный список пресетов 7д / 30д / 90д / Всё;
 *  - строгие day-ключи и календарные сдвиги (isDayKey, dayKeyOf, shiftDay, daysBetween, yearAgoDay);
 *  - resolvePeriod → включительное окно в днях, baselineWindow → равное прошлое окно или «год назад»,
 *    splitWindowRows → строки окна и базы с правилом полного покрытия архивом;
 *  - правило гранулярности (grainOptions, defaultGrain) и подпись окна (periodLabel);
 *  - прежние оконные примитивы на epoch ms (previousCalendarWindow, splitCalendarRows, inRangeByDays, …)
 *    переехали сюда как есть: их скользящие N×24 ч у лент TG/IG — вопрос OD-8, до решения их
 *    семантика не меняется.
 *
 * includeToday и зона дня — ЯВНЫЕ параметры без умолчаний: умолчания выбирает OD-8, а до него
 * каждый потребитель передаёт своё нынешнее значение (МойСклад и соседи: сегодня входит в окно,
 * день — календарь браузера).
 *
 * Ожидания закреплены зеркальными векторами test/fixtures/period-vectors.json: их же читает
 * серверный node --test, поэтому клиент и сервер не могут разойтись в окне и прошлом окне.
 */

export type PeriodDays = 7 | 30 | 90 | 0;

/** Inclusive custom date window (epoch ms). When set, it overrides the `days` preset. */
export interface DateRange {
  from: number;
  to: number;
}

/** Calendar-day coordinate `YYYY-MM-DD` — not an instant. */
export type DayKey = string;

/** Whose calendar names the day: the viewer's browser (`local`) or UTC. */
export type DayZone = 'local' | 'UTC';

export type Grain = 'day' | 'week' | 'month';

/** The comparison baselines every surface shares: the immediately preceding equal window, or the
    same calendar dates a year earlier. */
export type BaselineMode = 'prev' | 'year';

/** THE preset list — feed chips, widget pills, report chips and explorer windows all read this. */
export const PERIOD_PRESETS: ReadonlyArray<{ readonly days: PeriodDays; readonly label: string }> = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

/** The valid `days` values (for parsing stored or linked periods). */
export const PERIOD_DAYS: readonly PeriodDays[] = PERIOD_PRESETS.map((preset) => preset.days);

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` → [y, m, d] when it is a real calendar date (2026-02-31 is not), else null. */
function dayParts(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const match = DAY_KEY_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Date.UTC silently rolls 2026-02-31 into March (and maps years 0–99 onto 19xx): round-trip it.
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
    ? [year, month, day]
    : null;
}

/** Strict day key: the format AND a real calendar date (mirror of the server's isDayKey). */
export function isDayKey(value: unknown): value is DayKey {
  return dayParts(value) != null;
}

/** epoch ms → the calendar day it falls on in `zone`. */
export function dayKeyOf(ms: number, zone: DayZone): DayKey {
  const d = new Date(ms);
  return zone === 'UTC'
    ? `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
    : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The day `offset` calendar days away. Calendar arithmetic — DST cannot shift it. Malformed → null. */
export function shiftDay(key: DayKey, offset: number): DayKey | null {
  const parts = dayParts(key);
  if (!parts) return null;
  const [year, month, day] = parts;
  return dayKeyOf(Date.UTC(year, month - 1, day + offset), 'UTC');
}

/** Inclusive number of days in `[from..to]` (NaN for a malformed key). */
export function daysBetween(from: DayKey, to: DayKey): number {
  const a = dayParts(from);
  const b = dayParts(to);
  if (!a || !b) return Number.NaN;
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / DAY_MS) + 1;
}

/** The same calendar date a year earlier; 29 Feb → 28 Feb. Malformed → null. */
export function yearAgoDay(key: DayKey): DayKey | null {
  const parts = dayParts(key);
  if (!parts) return null;
  const [year, month, day] = parts;
  return `${String(year - 1).padStart(4, '0')}-${pad2(month)}-${pad2(month === 2 && day === 29 ? 28 : day)}`;
}

// ── Window in calendar days ───────────────────────────────────────────────────────────────────

/** An inclusive window of calendar days. «Всё» has no bounds (`all`, from/to null). */
export interface PeriodWindow {
  /** The preset as selected (for a custom range — the preset it sits on); 0 = «Всё». */
  days: number;
  all: boolean;
  /** True only for a user-picked range (not a preset expanded to its bounds). */
  custom: boolean;
  from: DayKey | null;
  to: DayKey | null;
}

export interface ResolvePeriodOptions {
  now: number;
  /** Does the (still incomplete) today close the preset window? The default is OD-8's to choose. */
  includeToday: boolean;
  /** Whose calendar names the days. The default is OD-8's to choose. */
  zone: DayZone;
}

/**
 * A page/widget period → its inclusive calendar window. A custom range keeps its exact days; a
 * 7/30/90 preset ends today (or yesterday without `includeToday`) and spans exactly `days` days;
 * «Всё» (days ≤ 0) stays unbounded.
 */
export function resolvePeriod(
  input: { days: number; range?: DateRange | null },
  { now, includeToday, zone }: ResolvePeriodOptions,
): PeriodWindow {
  if (input.range) {
    return {
      days: input.days,
      all: false,
      custom: true,
      from: dayKeyOf(input.range.from, zone),
      to: dayKeyOf(input.range.to, zone),
    };
  }
  if (!(input.days > 0)) return { days: input.days, all: true, custom: false, from: null, to: null };
  const today = dayKeyOf(now, zone);
  const to = includeToday ? today : shiftDay(today, -1);
  const from = to == null ? null : shiftDay(to, -(input.days - 1));
  return { days: input.days, all: false, custom: false, from, to };
}

/**
 * The comparison window: `prev` — the immediately preceding window of the same length, ending the
 * day before `from`; `year` — the same calendar dates a year earlier (29 Feb → 28 Feb). «Всё» has
 * no honest baseline → null.
 */
export function baselineWindow(window: PeriodWindow, mode: BaselineMode): PeriodWindow | null {
  if (window.all || !window.from || !window.to) return null;
  let from: DayKey | null;
  let to: DayKey | null;
  if (mode === 'year') {
    from = yearAgoDay(window.from);
    to = yearAgoDay(window.to);
  } else {
    const length = daysBetween(window.from, window.to);
    if (!(length > 0)) return null;
    from = shiftDay(window.from, -length);
    to = shiftDay(window.from, -1);
  }
  return from && to ? { ...window, from, to } : null;
}

/** How the archive covers the previous window: `full` — compared honestly; `partial` — the archive
    starts inside it; `none` — it starts after it (or nothing is dated); null — «Всё» has no baseline. */
export type BaselineCoverage = 'full' | 'partial' | 'none' | null;

export interface WindowRows<T> {
  current: T[];
  /** Rows of the immediately preceding equal window — only when the archive covers it fully. */
  previous: T[] | null;
  coverage: BaselineCoverage;
}

/**
 * Current and previous-window rows of a day-keyed series. The previous window is compared only when
 * the archive reaches its first day (the splitCalendarRows rule): a half-covered baseline would
 * inflate the delta. Rows with a malformed day are skipped; «Всё» returns the rows untouched.
 */
export function splitWindowRows<T>(
  rows: T[],
  window: PeriodWindow,
  dayOf: (row: T, index: number) => DayKey | null | undefined,
): WindowRows<T> {
  const { from, to } = window;
  if (window.all || !from || !to) return { current: rows, previous: null, coverage: null };
  const dated = rows.flatMap((row, index) => {
    const day = dayOf(row, index);
    return isDayKey(day) ? [{ row, day }] : [];
  });
  const current = dated.filter(({ day }) => day >= from && day <= to).map(({ row }) => row);
  const base = baselineWindow(window, 'prev');
  if (!base?.from || !base.to || dated.length === 0) return { current, previous: null, coverage: 'none' };
  const { from: baseFrom, to: baseTo } = base;
  const earliest = dated.reduce((min, { day }) => (day < min ? day : min), dated[0].day);
  if (earliest <= baseFrom) {
    const previous = dated.filter(({ day }) => day >= baseFrom && day <= baseTo).map(({ row }) => row);
    return { current, previous, coverage: 'full' };
  }
  return { current, previous: null, coverage: earliest <= baseTo ? 'partial' : 'none' };
}

// ── Granularity ───────────────────────────────────────────────────────────────────────────────

/** Which grains a window of `days` days can show (the TG explorer rule: a week from 14 days, a month
    from 60). An unbounded window (≤ 0, NaN, Infinity) allows every grain. */
export function grainOptions(days: number): Record<Grain, boolean> {
  const unbounded = !(days > 0);
  return { day: true, week: unbounded || days >= 14, month: unbounded || days >= 60 };
}

/** The grain a window of `days` days falls back to without an explicit choice — the mirror of the
    server's defaultGrain (server/domain/period.js). «Всё» goes by months. */
export function defaultGrain(days: number): Grain {
  if (!days || days > 180) return 'month';
  if (days > 31) return 'week';
  return 'day';
}

// ── Label ─────────────────────────────────────────────────────────────────────────────────────

/** `prefixed` — «за 30 дн.» / «за всё время» / «за выбранный период»; `bare` — the same without «за». */
export type PeriodLabelForm = 'prefixed' | 'bare';

/** The one window caption. */
export function periodLabel(window: Pick<PeriodWindow, 'days' | 'custom'>, form: PeriodLabelForm): string {
  const noun = window.custom ? 'выбранный период' : window.days > 0 ? `${window.days} дн.` : 'всё время';
  return form === 'prefixed' ? `за ${noun}` : noun;
}

// ── Legacy epoch-ms windows (moved from lib/period as-is; OD-8 decides their semantics) ─────────

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

export function inRangeByDays(dateISO: string | null | undefined, days: PeriodDays): boolean {
  if (days === 0) return true;
  if (!dateISO) return false;
  const timestamp = periodDateTimestamp(dateISO);
  return Number.isFinite(timestamp) && timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
}

/** Inclusive epoch-ms window. `null` is the unbounded «Всё» period. */
export interface CalendarWindow {
  from: number;
  to: number;
}

/** Immediately preceding equal window. Full local-day ranges move by calendar days so DST does
    not change the selected dates; rolling windows keep their exact inclusive millisecond span. */
export function previousCalendarWindow(window: CalendarWindow): CalendarWindow | null {
  if (!Number.isFinite(window.from) || !Number.isFinite(window.to) || window.to < window.from) {
    return null;
  }
  const isCalendarRange = startOfLocalDay(window.from) === window.from && endOfLocalDay(window.to) === window.to;
  const fromDay = new Date(window.from);
  const toDay = new Date(window.to);
  const calendarDays = Math.round(
    (Date.UTC(toDay.getFullYear(), toDay.getMonth(), toDay.getDate())
      - Date.UTC(fromDay.getFullYear(), fromDay.getMonth(), fromDay.getDate())) / DAY_MS,
  ) + 1;
  const span = window.to - window.from + 1;
  return {
    from: isCalendarRange ? shiftLocalDays(window.from, -calendarDays) : window.from - span,
    to: window.from - 1,
  };
}

/** Calendar window for a preset. The boundary matches {@link inRangeByDays}. */
export function calendarWindowForDays(days: number, now: number = Date.now()): CalendarWindow | null {
  return days === 0 ? null : { from: now - days * DAY_MS, to: now };
}

/** Exact custom range when present, otherwise the widget's preset window. */
export function calendarWindowForPeriod(
  period: { days: number; range: DateRange | null },
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
  const previousWindow = previousCalendarWindow(window);
  if (!previousWindow) return { current, previous: null, windowable: true };
  const earliest = Math.min(...dated.map(({ timestamp }) => timestamp));
  const previous =
    earliest <= previousWindow.from
      ? dated
          .filter(({ timestamp }) => timestamp >= previousWindow.from && timestamp <= previousWindow.to)
          .map(({ row }) => row)
      : null;

  return { current, previous, windowable: true };
}
