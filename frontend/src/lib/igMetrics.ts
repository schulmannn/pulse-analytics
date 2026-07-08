// Pure Instagram metric math + label/geo helpers. No React, no UI — the views and the
// useIgData hook gather raw API payloads and lean on this to shape them. Kept separate so the
// "what the numbers mean" logic is testable and the panels stay presentational.
import type { IgBreakdowns, IgHistoryRow, IgInsights, IgOnline, IgPost } from '@/api/schemas';
import { pctDelta, type MetricDelta } from '@/lib/delta';
import { fmt } from '@/lib/format';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// media_product_type → label / stable chart hue (a format keeps its colour across sorts).
export const MEDIA_PRODUCT_LABEL: Record<string, string> = {
  POST: 'Лента', FEED: 'Лента', REEL: 'Reels', REELS: 'Reels', STORY: 'Stories', CAROUSEL_ALBUM: 'Карусель',
};
export const MEDIA_PRODUCT_CHART: Record<string, string> = {
  POST: 'hsl(var(--chart-1))', FEED: 'hsl(var(--chart-1))',
  REEL: 'hsl(var(--chart-2))', REELS: 'hsl(var(--chart-2))',
  STORY: 'hsl(var(--chart-3))', CAROUSEL_ALBUM: 'hsl(var(--chart-4))',
};
// Categorical identity cycle: the -cat tokens resolve to the saturated set in light and the
// validated pastel family in dark (see index.css) — donut slices and breakdown dots follow theme.
export const CHART_CYCLE = [
  'hsl(var(--chart-1-cat))', 'hsl(var(--chart-2-cat))', 'hsl(var(--chart-3-cat))',
  'hsl(var(--chart-4-cat))', 'hsl(var(--chart-5-cat))', 'hsl(var(--chart-6-cat))',
];
// Post card badge keys off media_type (IMAGE/VIDEO/CAROUSEL_ALBUM/REELS).
export const MEDIA_TYPE_LABEL: Record<string, string> = {
  IMAGE: 'Фото', VIDEO: 'Видео', CAROUSEL_ALBUM: 'Карусель', REELS: 'Reels',
};
export const GENDER_LABEL: Record<string, string> = { F: 'Женщины', M: 'Мужчины', U: 'Не указан' };
export const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
export const CONTACT_LABEL: Record<string, string> = {
  WEBSITE: 'Сайт', EMAIL: 'Почта', CALL: 'Звонок', DIRECTION: 'Маршрут', TEXT: 'Сообщение', BOOK_NOW: 'Бронь',
};
export const CONTACT_ICON: Record<string, string> = {
  WEBSITE: '🔗', EMAIL: '✉️', CALL: '📞', DIRECTION: '📍', TEXT: '💬', BOOK_NOW: '🗓️',
};
export const NAV_LABEL: Record<string, string> = {
  tap_forward: 'Вперёд', tap_back: 'Назад', tap_exit: 'Выход', swipe_forward: 'Свайп к следующему',
};

export interface Point {
  day: string;
  value: number;
}

/** Daily time_series metric → {day,value}[] (oldest→newest). On the Instagram-Login API the
    engagement metrics (views/saves/total_interactions/…) arrive as a single total_value aggregate
    with no daily series — surfaced as one synthetic point so the window math reads the real number. */
export function metricSeries(insights: IgInsights | undefined, name: string): Point[] {
  const metric = insights?.data?.find((m) => m.name === name);
  if (!metric) return [];
  const series = (metric.values ?? [])
    .map((v) => ({ day: v.end_time ?? '', value: Number(typeof v.value === 'object' ? 0 : v.value ?? 0) }))
    .filter((p) => p.day !== '');
  if (series.length) return series;
  const tv = metric.total_value?.value;
  return tv != null ? [{ day: 'total', value: Number(tv) }] : [];
}

/** Persisted ig_daily rows → {day,value}[] for one column, dropping null/blank days. */
export function histSeries(rows: IgHistoryRow[] | undefined, col: keyof IgHistoryRow): Point[] {
  return (rows ?? [])
    .filter((r) => r.day && r[col] != null)
    .map((r) => ({ day: r.day, value: Number(r[col]) }));
}

/** Prefer whichever series carries MORE real dated points. The persisted history (accumulated by
 *  the cron) usually outruns the tiny live API window, but on day 1 the DB is empty — then the live
 *  series wins and the chart is never blank. Ties keep live (fresher within the shared window). */
export function longerSeries(live: Point[], persisted: Point[]): Point[] {
  const datedCount = (s: Point[]) =>
    s.filter((p) => p.day !== 'total' && Number.isFinite(Date.parse(p.day))).length;
  return datedCount(persisted) > datedCount(live) ? persisted : live;
}

/** Which metrics arrive as a real daily series (≥2 dated points) vs a windowed aggregate. Only the
    real series may be drawn as a daily chart — aggregates are shown as period comparisons instead. */
export function hasDailySeries(series: Point[]): boolean {
  return series.filter((p) => p.day !== 'total' && Number.isFinite(Date.parse(p.day))).length >= 2;
}

export interface WindowPair {
  cur: number;
  prev: number;
  hasCur: boolean;
  hasPrev: boolean;
}

/** Sum a daily series over [startMs, endMs] vs the equal-length window right before it. Explicit
    bounds so a custom date range maps to its exact span (not a windowDays reconstruction). */
export function windowPair(series: Point[], startMs: number, endMs: number): WindowPair {
  const span = Math.max(endMs - startMs, DAY_MS);
  const prevStart = startMs - span;
  let cur = 0;
  let prev = 0;
  let hasCur = false;
  let hasPrev = false;
  for (const p of series) {
    const t = Date.parse(p.day);
    if (!Number.isFinite(t) || t > endMs) continue;
    if (t >= startMs) { cur += p.value; hasCur = true; }
    else if (t >= prevStart) { prev += p.value; hasPrev = true; }
  }
  return { cur, prev, hasCur, hasPrev };
}

export const pairDelta = (p: WindowPair): MetricDelta | null =>
  p.hasCur && p.hasPrev ? pctDelta(p.cur, p.prev) : null;

/** total_value breakdown reader → {label,value}[] for a metric+dimension. */
export function tvBreakdown(
  data: IgBreakdowns['data'] | undefined,
  name: string,
  dim: string,
): { label: string; value: number }[] {
  for (const entry of (data ?? []).filter((m) => m.name === name)) {
    const block = entry.total_value?.breakdowns?.find((b) => (b.dimension_keys ?? []).includes(dim));
    if (block) {
      return (block.results ?? []).map((r) => ({ label: r.dimension_values?.[0] ?? '', value: Number(r.value ?? 0) }));
    }
  }
  return [];
}

export const fmtDay = (iso: string) => {
  const t = Date.parse(iso);
  // Short-month form (7 июл.) — the SAME date grammar TG charts use (аудит тултипов: IG
  // говорил 07.07, TG — 21 янв на соседних карточках).
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
};

export const flag = (iso: string) => {
  const cc = (iso || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0)));
};

/** Window an IG daily-Point series to the last `days` points (0 = «Всё»). Steep headline math:
    the metric page (/metrics/ig-*), the Home cards, and the narrative widget must all derive their
    IG numbers from THIS one function so they can never silently diverge — the contract test in
    igMetrics.test.ts pins narrative == this. Drops any 'total' marker; a shorter series returns all
    it has (never fabricates); prevTotal is null unless two full windows fit (honest comparison). */
export function windowIgSeries(series: Point[], days: number, unit: string) {
  const pts = series.filter((p) => p.day !== 'total');
  const n = days === 0 ? pts.length : Math.min(days, pts.length);
  const w = pts.slice(-n);
  const total = w.reduce((acc, p) => acc + p.value, 0);
  const prevSlice = days === 0 || pts.length < 2 * n ? null : pts.slice(-2 * n, -n);
  const prevTotal = prevSlice ? prevSlice.reduce((acc, p) => acc + p.value, 0) : null;
  return {
    values: w.map((p) => p.value),
    // FULL per-point labels (not pickLabels' 3) — LineChart picks first/mid/last itself, and
    // BarChart needs one label per bar to stride; the 3-label form mislabels the bars.
    labels: w.map((p) => fmtDay(p.day)),
    titles: w.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)} ${unit}`),
    total,
    prevTotal,
  };
}

// ── Geo normalization ──
// Instagram returns cities as "City, Region" (region often redundant or in English:
// "London, England", "Moscow, Moscow", "Yekaterinburg, Sverdlovsk Oblast"). Keep the city only, and
// localize the common RU/CIS cities (Instagram transliterates them) so the audience reads natively.
const CITY_RU: Record<string, string> = {
  Moscow: 'Москва',
  'Saint Petersburg': 'Санкт-Петербург',
  'St Petersburg': 'Санкт-Петербург',
  'St. Petersburg': 'Санкт-Петербург',
  Yekaterinburg: 'Екатеринбург',
  Ekaterinburg: 'Екатеринбург',
  Novosibirsk: 'Новосибирск',
  'Nizhny Novgorod': 'Нижний Новгород',
  Kazan: 'Казань',
  Chelyabinsk: 'Челябинск',
  Samara: 'Самара',
  'Rostov-on-Don': 'Ростов-на-Дону',
  Ufa: 'Уфа',
  Krasnoyarsk: 'Красноярск',
  Perm: 'Пермь',
  Voronezh: 'Воронеж',
  Volgograd: 'Волгоград',
  Krasnodar: 'Краснодар',
  Saratov: 'Саратов',
  Tyumen: 'Тюмень',
  Sochi: 'Сочи',
  Kyiv: 'Киев',
  Kiev: 'Киев',
  Minsk: 'Минск',
  Almaty: 'Алматы',
  Tashkent: 'Ташкент',
  Baku: 'Баку',
  Yerevan: 'Ереван',
  Tbilisi: 'Тбилиси',
  Bishkek: 'Бишкек',
};
export const cityName = (raw: string): string => {
  const city = (raw || '').split(',')[0].trim();
  return CITY_RU[city] || city || raw;
};

// Country codes → Russian names via the platform Intl data (covers every ISO-3166 code, not a hand
// list). Falls back to the raw code if the runtime can't resolve it.
let regionNames: Intl.DisplayNames | null = null;
try {
  regionNames = new Intl.DisplayNames(['ru'], { type: 'region' });
} catch {
  regionNames = null;
}
export const countryName = (code: string): string => {
  const cc = (code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return code;
  try {
    return regionNames?.of(cc) ?? code;
  } catch {
    return code;
  }
};

// ── online_followers (best-time) ──
export interface OnlineAgg {
  dayValues: NonNullable<IgOnline['data']>[number]['values'];
  grid: number[][];
  max: number;
  best: { w: number; h: number; v: number };
  /** True only when the metric actually returned activity — the new API often returns empty hour
      maps, and without this guard the all-zero grid would still yield a bogus "best slot" (Пн 0:00). */
  hasSignal: boolean;
}

/** Aggregate the online_followers daily hour-maps into a weekday×hour grid + best slot. */
export function aggregateOnline(online: IgOnline | undefined): OnlineAgg {
  const dayValues = online?.data?.[0]?.values ?? [];
  const sum: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const cnt: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  dayValues.forEach((d) => {
    const t = Date.parse(d.end_time ?? '');
    if (!Number.isFinite(t)) return;
    const w = (new Date(t).getUTCDay() + 6) % 7;
    const map = d.value ?? {};
    for (let h = 0; h < 24; h++) {
      const v = Number(map[String(h)] ?? 0);
      if (!Number.isFinite(v)) continue;
      sum[w][h] += v;
      cnt[w][h] += 1;
    }
  });
  const grid = sum.map((row, w) => row.map((s, h) => (cnt[w][h] ? s / cnt[w][h] : 0)));
  const max = Math.max(1, ...grid.flat());
  let best = { w: -1, h: -1, v: -1 };
  grid.forEach((row, w) => row.forEach((v, h) => { if (v > best.v) best = { w, h, v }; }));
  return { dayValues, grid, max, best, hasSignal: best.v > 0 };
}

// ── hashtags ──
export interface HashtagStat {
  tag: string;
  count: number;
  avgReach: number;
  avgEr: number;
  lift: number;
}

export const postEr = (p: IgPost): number => {
  const reach = Number(p.reach ?? 0);
  if (reach <= 0) return 0;
  const ti =
    Number(p.total_interactions ?? 0) ||
    Number(p.like_count ?? 0) + Number(p.comments_count ?? 0) + Number(p.saved ?? 0) + Number(p.shares ?? 0);
  return (ti / reach) * 100;
};

export function hashtagStats(posts: IgPost[]): HashtagStat[] {
  const map = new Map<string, { count: number; reach: number; er: number }>();
  let erSum = 0;
  let erCount = 0;
  for (const p of posts) {
    const reach = Number(p.reach ?? 0);
    if (reach <= 0) continue; // skip zero-reach posts for BOTH the baseline and per-tag stats
    const er = postEr(p);
    erSum += er;
    erCount += 1;
    const tags = (p.caption ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? [];
    for (const tag of new Set(tags.map((t) => t.toLowerCase()))) {
      const e = map.get(tag) ?? { count: 0, reach: 0, er: 0 };
      e.count += 1;
      e.reach += reach;
      e.er += er;
      map.set(tag, e);
    }
  }
  const globalEr = erCount > 0 ? erSum / erCount : 0;
  return [...map.entries()]
    .map(([tag, e]) => ({
      tag,
      count: e.count,
      avgReach: e.reach / e.count,
      avgEr: e.er / e.count,
      lift: globalEr > 0 ? ((e.er / e.count - globalEr) / globalEr) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count || b.avgEr - a.avgEr);
}
