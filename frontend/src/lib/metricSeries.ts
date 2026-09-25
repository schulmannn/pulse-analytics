/**
 * Pure daily/weekly/monthly bucketing helpers for the metric page — extracted so the
 * comparison-window invariant is unit-testable (a silent off-by-one there once dropped the
 * on-chart comparison entirely). No React: keys only, rendering stays in the panel.
 *
 * `fmt` появился здесь ради одного хелпера — `windowRangeLabel`. ГРАНИЦЫ ОКНА И ПОДПИСЬ ЭТИХ
 * ГРАНИЦ ОБЯЗАНЫ ЖИТЬ РЯДОМ: подпись читает ровно тот интервал, который вернул comparisonWindow,
 * и разъехавшись они солгут читателю (а не упадут). Модуль от этого не тяжелеет — lib/format уже
 * лежит в каждом чанке.
 */
import { fmt } from '@/lib/format';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The grains the metric page offers (its GRAIN_LABEL/GRAIN_WORD maps are keyed on this). */
export type Grain = 'day' | 'week' | 'month';
/** The richer grain set the metric builder offers (S10) — a superset of Grain. quarter/year bucket
 *  on the calendar like month; flow metrics still SUM per bucket and level metrics take the last
 *  value in the bucket (the caller chooses the aggregator, so no per-grain special-casing here). */
export type SeriesGrain = Grain | 'quarter' | 'year';

/** Bucket key for an instant: `YYYY-MM-DD` (day / Monday of the week), `YYYY-MM` (month),
 *  `YYYY-Qn` (quarter) or `YYYY` (year). All UTC. */
export function bucketKeyOf(t: number, grain: SeriesGrain): string {
  const d = new Date(t);
  if (grain === 'day') return d.toISOString().slice(0, 10);
  if (grain === 'week') {
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  if (grain === 'quarter') return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  if (grain === 'year') return String(d.getUTCFullYear());
  return d.toISOString().slice(0, 7); // month
}

/** All bucket keys covering [from..to], in order (day steps / Mondays / first-of-month / quarter /
 *  year). Calendar grains (month/quarter/year) walk the calendar; day/week walk fixed steps. */
export function bucketKeysInWindow(fromMs: number, toMs: number, grain: SeriesGrain): string[] {
  const keys: string[] = [];
  if (grain === 'month' || grain === 'quarter' || grain === 'year') {
    const d = new Date(fromMs);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    if (grain === 'quarter') d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3); // first month of the quarter
    if (grain === 'year') d.setUTCMonth(0);
    while (d.getTime() <= toMs) {
      keys.push(bucketKeyOf(d.getTime(), grain));
      if (grain === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
      else d.setUTCMonth(d.getUTCMonth() + (grain === 'quarter' ? 3 : 1));
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

/** Границы серии по её РЕАЛЬНЫМ крайним дням (архивы IG/Метрики/упоминаний знают свои дни, а не
    арифметическое окно). `null` на пустой серии — подписывать нечего, и выдумывать границы нельзя. */
export function dayRangeOf(days: string[]): { from: string; to: string } | null {
  const from = days[0];
  const to = days[days.length - 1];
  return from && to ? { from, to } : null;
}

/** Календарный год границы окна. Дневной ключ `YYYY-MM-DD` — это КАЛЕНДАРНАЯ дата в любой зоне
    (тот же разбор, что у `fmt.day`), а не момент; момент читается по локальной зоне читателя. */
function windowYear(v: number | string): number | null {
  if (typeof v === 'string') {
    const key = /^(\d{4})-\d{2}-\d{2}$/.exec(v);
    if (key) return Number(key[1]);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getFullYear();
}

/**
 * Подпись диапазона окна для легенды сравнения: «29 мая – 4 июн.», «22 дек. 2025 г. – 4 янв. 2026 г.».
 *
 * ГОД ПЕЧАТАЕТСЯ ТОЛЬКО ТАМ, ГДЕ БЕЗ НЕГО ПОДПИСЬ ВРЁТ: окно ушло в другой календарный год (база
 * «Год назад») или само пересекает Новый год. Иначе «5 июн.» текущего окна и «5 июн.» прошлогоднего
 * нечем отличить — а год на каждой границе в рейле шириной 300px это шум, который вытесняет само
 * число. Ровно та же развилка уже описана у `fmt.dayYear`.
 *
 * Границы принимаются и моментом (winFrom/winTo метрик-страницы), и дневным ключом `YYYY-MM-DD`
 * (архивные серии IG/Метрики знают СВОИ дни, а не арифметическое окно, и на дырах архива честнее
 * подписать реальные крайние дни).
 *
 * `now` — параметром, а не Date.now() внутри: иначе тест на «текущий год» протухал бы 1 января.
 */
export function windowRangeLabel(
  win: { from: number | string; to: number | string },
  now: number = Date.now(),
): string {
  const from = fmt.day(win.from);
  const to = fmt.day(win.to);
  if (!from || !to) return '';
  const fromYear = windowYear(win.from);
  const toYear = windowYear(win.to);
  const thisYear = new Date(now).getFullYear();
  const straddles = fromYear != null && toYear != null && fromYear !== toYear;
  const needYear = straddles || fromYear !== thisYear || toYear !== thisYear;
  // Год на ОБЕИХ границах — только когда окно их пересекает; ушедшему целиком в прошлое хватает
  // года на конце («5 – 11 июн. 2025 г.»), два одинаковых года подряд читаются как заикание.
  return `${straddles ? fmt.dayYear(win.from) : from} – ${needYear ? fmt.dayYear(win.to) : to}`;
}

/** Fit a comparison (previous-period) series to the active series length: on odd windows the
 *  baseline can overshoot by a bucket at the tail — drop the extra tail (keep leading buckets
 *  aligned day-for-day); front-pad with zeros if short. */
// ХВОСТ: front-pad нулями — это тот самый «ноль, которого не было» (базовый период, не покрывающий
// начало окна, объявляется нулевым). Тип уже допускает `null`, так что замена padding'а на пропуск
// технически возможна, но меняет вид всех сравнений разом — вынесено из волны честности рядов.
export function alignGhost(vals: Array<number | null>, n: number): Array<number | null> {
  if (vals.length === n) return vals;
  if (vals.length > n) return vals.slice(0, n);
  return [...new Array(n - vals.length).fill(0), ...vals];
}

/**
 * True when a per-post SUM over the baseline window is COMPLETE (so a comparison/ghost off it is
 * trustworthy). Posts are fetched with a server cap (~100), so a previous-period / year-ago window
 * often starts BEFORE the oldest loaded post — then the sum undercounts and a comparison % is
 * nonsense (a metric page showed «прошлый период 1.2k · +969.3%» while the archive-based hero showed
 * −9%). The caller must SUPPRESS the ghost + rail comparison in that case rather than mislead.
 *
 * `capped` = did the fetch hit its limit (more posts may exist beyond the oldest loaded one)? When
 * FALSE we loaded ALL the channel's posts, so the sum is complete even if the baseline is genuinely
 * sparse → always covered (never over-suppress a small/new channel). When TRUE (default — the
 * conservative choice), coverage requires the oldest loaded post to reach the baseline start; empty
 * / all-undated → false. `postDatesMs` is each loaded post's parsed date in epoch ms (NaN ignored). */
export function baselineCoveredByPosts(postDatesMs: number[], baseFrom: number, capped = true): boolean {
  if (!capped) return true;
  let oldest = Infinity;
  for (const t of postDatesMs) if (Number.isFinite(t) && t < oldest) oldest = t;
  return Number.isFinite(oldest) && oldest <= baseFrom;
}

// ── Self-referential comparison baselines (S8 presets) ───────────────────────────────────────────
// Unlike the shifted-window baselines above, these are derived from the ALREADY-RESOLVED series, so
// they apply uniformly to any series metric (TG core / post-derived / IG) with no extra data fetch.

/** Weekday (0=Sun..6=Sat, UTC) of a plain `YYYY-MM-DD` key, or null if it isn't one (month/quarter/
 *  year buckets, or a malformed key). */
export function weekdayOfKey(key: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const t = Date.parse(`${key}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t).getUTCDay() : null;
}

/** Trailing moving-average baseline: `out[i]` = mean of the last `window` values up to i (inclusive) —
 *  the series' OWN smoothed run-rate, so each point reads against its recent trend. Same length as
 *  `values`; leading points average a shorter run. Non-finite values are skipped in the mean. */
export function movingAverageGhost(values: number[], window: number): number[] {
  const w = Math.max(1, Math.floor(window));
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - w + 1); j <= i; j += 1) {
      if (Number.isFinite(values[j])) {
        sum += values[j];
        n += 1;
      }
    }
    return n > 0 ? sum / n : 0;
  });
}

/** «Typical weekday» baseline: `out[i]` = mean of all values sharing point i's weekday, so each day
 *  reads against a typical same-weekday value in the window. Needs day-grain `YYYY-MM-DD` keys with
 *  ≥2 distinct weekdays; returns null otherwise (week/month/… buckets, where «weekday» is degenerate),
 *  so the caller can fall back honestly. Non-finite values are skipped in the per-weekday mean. */
export function sameWeekdayGhost(dates: string[], values: number[]): number[] | null {
  if (dates.length !== values.length || dates.length === 0) return null;
  const wd: number[] = [];
  for (const d of dates) {
    const w = weekdayOfKey(d);
    if (w == null) return null;
    wd.push(w);
  }
  if (new Set(wd).size < 2) return null; // a single weekday (weekly buckets) — «same weekday» is moot
  const sum = new Array(7).fill(0);
  const cnt = new Array(7).fill(0);
  values.forEach((v, i) => {
    if (Number.isFinite(v)) {
      sum[wd[i]] += v;
      cnt[wd[i]] += 1;
    }
  });
  return wd.map((w) => (cnt[w] > 0 ? sum[w] / cnt[w] : 0));
}
