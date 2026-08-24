import { parseDayKey } from '@/lib/format';

export interface ActivityCalendarPoint {
  day: string;
  views: number;
  /** Есть ли за этот день данные вообще. Источник с ручной загрузкой обязан отличать «ноль
      заказов» от «выгрузка не залита»; у источников с автосбором поле не задаётся. */
  covered?: boolean;
}

export interface ActivityCalendarDay {
  day: string;
  value: number;
  level: 0 | 1 | 2 | 3 | 4;
  isToday: boolean;
  /** false = данных за день нет (не «ноль»). См. defaultCovered в buildActivityCalendar. */
  covered: boolean;
}

export interface ActivityCalendarWeek {
  key: string;
  /** The calendar day whose short month label starts above this week. */
  monthDay: string | null;
  /** Monday-first cells. `null` is outside the exact 365-day window or in the future. */
  days: Array<ActivityCalendarDay | null>;
}

export interface ActivityCalendarModel {
  weeks: ActivityCalendarWeek[];
  thresholds: [number, number, number] | null;
  total: number;
  peak: ActivityCalendarDay | null;
  hasHistory: boolean;
}

const DAY_COUNT = 365;

function localMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function quantile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0] ?? 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

/** p25/p50/p75 over real non-zero days. Linear interpolation keeps two-day histories useful. */
export function activityQuantiles(values: readonly number[]): [number, number, number] | null {
  const nonzero = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (nonzero.length === 0) return null;
  return [quantile(nonzero, 0.25), quantile(nonzero, 0.5), quantile(nonzero, 0.75)];
}

export function activityLevel(value: number, thresholds: [number, number, number] | null): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!thresholds) return 0;
  if (value < thresholds[0]) return 1;
  if (value < thresholds[1]) return 2;
  if (value < thresholds[2]) return 3;
  return 4;
}

/**
 * Builds an exact trailing-365-day, Monday-first calendar. Bare API day keys are parsed at local
 * midnight; absent observations stay honest zero cells, while alignment/future slots stay `null`.
 */
/**
 * @param defaultCovered чем считать день, которого нет во входных точках. У источников с
 * автосбором (Telegram) пропуск точки — это просто ноль, поэтому true. У источника с ручной
 * загрузкой пропуск означает «за этот день выгрузку не заливали», и это надо показать штриховкой,
 * а не нулём: иначе дыра в загрузке читается как провал продаж.
 */
export function buildActivityCalendar(
  points: readonly ActivityCalendarPoint[],
  now: Date = new Date(),
  { defaultCovered = true }: { defaultCovered?: boolean } = {},
): ActivityCalendarModel {
  const today = localMidnight(now);
  const start = addDays(today, -(DAY_COUNT - 1));
  const gridStart = addDays(start, -((start.getDay() + 6) % 7));
  const todayKey = dayKey(today);
  const valuesByDay = new Map<string, number>();
  const coveredByDay = new Map<string, boolean>();

  for (const point of points) {
    const parsed = parseDayKey(point.day);
    if (!parsed || parsed < start || parsed > today || !Number.isFinite(point.views)) continue;
    valuesByDay.set(point.day, Math.max(0, point.views));
    coveredByDay.set(point.day, point.covered ?? true);
  }

  const values = Array.from(valuesByDay.values()).filter((value) => value > 0);
  const thresholds = activityQuantiles(values);
  const weeks: ActivityCalendarWeek[] = [];
  let total = 0;
  let peak: ActivityCalendarDay | null = null;

  // 365 days plus at most six leading alignment cells always occupy exactly 53 Monday-first weeks.
  for (let weekIndex = 0; weekIndex < 53; weekIndex++) {
    const weekStart = addDays(gridStart, weekIndex * 7);
    const days: Array<ActivityCalendarDay | null> = [];
    let monthDay: string | null = null;

    for (let weekday = 0; weekday < 7; weekday++) {
      const date = addDays(weekStart, weekday);
      if (date < start || date > today) {
        days.push(null);
        continue;
      }

      const key = dayKey(date);
      const value = valuesByDay.get(key) ?? 0;
      const cell: ActivityCalendarDay = {
        day: key,
        value,
        level: activityLevel(value, thresholds),
        isToday: key === todayKey,
        covered: coveredByDay.get(key) ?? defaultCovered,
      };
      days.push(cell);
      total += value;
      if (value > 0 && (!peak || value > peak.value)) peak = cell;
      if (date.getDate() === 1) monthDay = key;
    }

    // The first visible week names its partial month even when day 1 predates the 365-day window.
    const firstVisible = days.find((cell): cell is ActivityCalendarDay => cell !== null);
    if (weekIndex === 0 && firstVisible) monthDay = firstVisible.day;
    weeks.push({ key: dayKey(weekStart), monthDay, days });
  }

  return { weeks, thresholds, total, peak, hasHistory: valuesByDay.size > 0 };
}
