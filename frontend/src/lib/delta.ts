export interface MetricDelta {
  pct: number;
  dir: 'up' | 'down' | 'flat';
}

/** Почему сравнивать не с чем — текст подсказки у слота «нет базы». Причину знает считающий
    (kpiDerive / IG-окно), а не карточка: «Всё» и кастомный диапазон не имеют парного окна вовсе,
    у остальных база бывает короче архива. */
export const NO_BASIS_ALL_TIME = 'окно «Всё» — прошлого периода не существует';
export const NO_BASIS_CUSTOM_RANGE = 'свой период — парного прошлого окна нет';
export const NO_BASIS_SHORT_ARCHIVE = 'архив короче окна — сравнивать не с чем';

export interface DatedPostMetrics {
  date?: string | null;
  views: number;
  reactions: number;
  forwards: number;
  replies: number;
}

/**
 * Границы окна в ms, ОБЕ включительно (`to` — последний момент, попавший в сумму).
 *
 * Отдаются РЯДОМ с суммами, а не пересчитываются читателем: пилюля дельты обязана назвать ровно то
 * окно, по которому дельта посчитана. Пока границы жили только внутри этих функций, «пред. период»
 * в интерфейсе был словом без содержания — читателю неоткуда было узнать, с чем сравнили.
 * Подписывается хелпером `windowRangeLabel` (lib/metricSeries) — структурно совместимый тип.
 */
export interface WindowRange {
  from: number;
  to: number;
}

/** Границы окна дневного АРХИВА — реальные крайние day-key'и, попавшие в сумму (а не арифметика
    окна): на дырявом архиве «7 июл. – 6 авг.» солгало бы про дни, которых в сумме нет. */
export interface DayRange {
  from: string;
  to: string;
}

export interface PostWindowTotals {
  current: Omit<DatedPostMetrics, 'date'>;
  previous: Omit<DatedPostMetrics, 'date'>;
  /** Окна, по которым посчитаны суммы: `previous.to` — последняя мс перед `current.from`. */
  ranges: { current: WindowRange; previous: WindowRange };
}

export interface SubscriberHistoryRow {
  day: string;
  subscribers?: number | null;
}

export interface DailyWindowSlice<T> {
  rows: T[];
  total: number;
  /** Крайние дни, реально вошедшие в `total`; null — окно пустое. */
  range: DayRange | null;
}

export interface DailyWindowPair<T> {
  current: DailyWindowSlice<T>;
  previous: DailyWindowSlice<T>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function pctDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
): MetricDelta | null {
  if (
    current == null
    || previous == null
    || !Number.isFinite(current)
    || !Number.isFinite(previous)
    || current < 0
    || previous <= 0
  ) {
    return null;
  }

  const change = ((current - previous) / Math.abs(previous)) * 100;
  return {
    pct: Math.abs(change),
    dir: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
  };
}

export function sumPostWindows(
  posts: DatedPostMetrics[],
  days: number,
  now = Date.now(),
): PostWindowTotals | null {
  if (!Number.isFinite(days) || days <= 0) return null;

  const currentStart = now - days * DAY_MS;
  const previousStart = now - days * 2 * DAY_MS;
  const datedPosts = posts
    .map((post) => ({ post, timestamp: post.date ? Date.parse(post.date) : Number.NaN }))
    .filter(({ timestamp }) => Number.isFinite(timestamp));

  const earliestTimestamp = Math.min(...datedPosts.map(({ timestamp }) => timestamp));
  if (!Number.isFinite(earliestTimestamp) || earliestTimestamp > previousStart) return null;

  const emptyTotals = (): Omit<DatedPostMetrics, 'date'> => ({
    views: 0,
    reactions: 0,
    forwards: 0,
    replies: 0,
  });
  const current = emptyTotals();
  const previous = emptyTotals();

  datedPosts.forEach(({ post, timestamp }) => {
    const target = timestamp >= currentStart && timestamp <= now
      ? current
      : timestamp >= previousStart && timestamp < currentStart
        ? previous
        : null;
    if (!target) return;

    target.views += post.views;
    target.reactions += post.reactions;
    target.forwards += post.forwards;
    target.replies += post.replies;
  });

  return {
    current,
    previous,
    // Границы — те же, по которым только что разложены посты. Окно СКОЛЬЗЯЩЕЕ (не выровнено по
    // суткам), поэтому граничный календарный день честно принадлежит обоим окнам: пост в 14:00
    // попадает в прошлое, в 15:00 — в текущее.
    ranges: {
      current: { from: currentStart, to: now },
      previous: { from: previousStart, to: currentStart - 1 },
    },
  };
}

interface SubscriberPoint {
  day: string;
  timestamp: number;
  subscribers: number;
}

/**
 * Концы окна подписчиков: последняя известная точка и БАЗОВАЯ (последняя не позже границы окна).
 *
 * Один разбор на трёх читателей — процент (`subscriberDelta`), абсолютное изменение
 * (`subscriberChange`) и основание пилюли (`subscriberBaseline`). Разбор был скопирован дословно
 * дважды; третья копия ради подписи означала бы, что процент и названная под ним база могут
 * разойтись от одной невнимательной правки — а именно эту связь подпись и обещает читателю.
 */
function subscriberEnds(
  rows: SubscriberHistoryRow[],
  days: number,
  now: number,
): { latest: SubscriberPoint; baseline: SubscriberPoint } | null {
  if (!Number.isFinite(days) || days <= 0) return null;

  const target = now - days * DAY_MS;
  const points = rows
    .filter((row) => row.subscribers != null)
    .map((row) => ({ day: row.day, timestamp: Date.parse(row.day), subscribers: Number(row.subscribers) }))
    .filter(
      (point) => (
        Number.isFinite(point.timestamp)
        && point.timestamp <= now
        && Number.isFinite(point.subscribers)
      ),
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  const latest = points.at(-1);
  const baseline = points.filter((point) => point.timestamp <= target).at(-1);
  if (!latest || !baseline) return null;
  return { latest, baseline };
}

/**
 * Точка, ОТ КОТОРОЙ считается дельта подписчиков: день архива и уровень в нём. У подписчиков база —
 * не окно, а один замер (уровень, а не поток), поэтому пилюля называет дату и число, а не диапазон.
 */
export function subscriberBaseline(
  rows: SubscriberHistoryRow[],
  days: number,
  now = Date.now(),
): { day: string; subscribers: number } | null {
  const ends = subscriberEnds(rows, days, now);
  return ends ? { day: ends.baseline.day, subscribers: ends.baseline.subscribers } : null;
}

export function subscriberDelta(
  rows: SubscriberHistoryRow[],
  days: number,
  now = Date.now(),
): MetricDelta | null {
  const ends = subscriberEnds(rows, days, now);
  return ends ? pctDelta(ends.latest.subscribers, ends.baseline.subscribers) : null;
}

/**
 * Absolute subscriber change (latest − baseline) over the `days` window — the signed integer
 * behind the subscriber percent delta ("−108 за период"). Mirrors subscriberDelta's point
 * selection. Returns null if either endpoint is missing; days<=0 (all-time) → null.
 */
export function subscriberChange(
  rows: SubscriberHistoryRow[],
  days: number,
  now = Date.now(),
): number | null {
  const ends = subscriberEnds(rows, days, now);
  return ends ? ends.latest.subscribers - ends.baseline.subscribers : null;
}

/**
 * Split a daily FLOW archive into the current and previous rolling windows and calculate both
 * totals in one pass. Callers use the returned rows for charts and the totals for labels, so the
 * visual series, headline delta and comparison rail cannot silently choose different boundary
 * days. Returns null unless both windows contain at least one valid point.
 */
export function splitDailyWindows<T extends { day: string }>(
  rows: T[],
  pick: (row: T) => number,
  days: number,
  now = Date.now(),
): DailyWindowPair<T> | null {
  if (!Number.isFinite(days) || days <= 0) return null;

  const currentStart = now - days * DAY_MS;
  const previousStart = now - days * 2 * DAY_MS;
  const pair: DailyWindowPair<T> = {
    current: { rows: [], total: 0, range: null },
    previous: { rows: [], total: 0, range: null },
  };
  for (const row of rows) {
    const timestamp = Date.parse(row.day);
    if (!Number.isFinite(timestamp) || timestamp > now) continue;
    const value = pick(row);
    if (!Number.isFinite(value)) continue;

    const target = timestamp >= currentStart
      ? pair.current
      : timestamp >= previousStart
        ? pair.previous
        : null;
    if (!target) continue;
    target.rows.push(row);
    target.total += value;
  }

  if (pair.current.rows.length === 0 || pair.previous.rows.length === 0) return null;
  pair.current.range = dayRangeOfRows(pair.current.rows);
  pair.previous.range = dayRangeOfRows(pair.previous.rows);
  return pair;
}

/** Крайние дни, реально попавшие в срез. Считается ПО ФАКТУ, а не по границам окна: архив бывает
    дырявым (бэкфилл не дошёл), и арифметическое «7 июл. – 6 авг.» назвало бы читателю дни, которых
    в сумме нет. Порядок входа не предполагается — сравниваем моменты, а не строки. */
function dayRangeOfRows<T extends { day: string }>(rows: T[]): DayRange | null {
  let from: T | null = null;
  let to: T | null = null;
  for (const row of rows) {
    const t = Date.parse(row.day);
    if (!Number.isFinite(t)) continue;
    if (from == null || t < Date.parse(from.day)) from = row;
    if (to == null || t > Date.parse(to.day)) to = row;
  }
  return from && to ? { from: from.day, to: to.day } : null;
}

/**
 * Period-over-period delta for a daily FLOW metric (views / forwards / reactions) read
 * from the channel_daily archive — the same reliable source the subscriber delta uses.
 * Sums `pick(row)` over the current window [now-days, now] vs the previous window
 * [now-2·days, now-days]. Returns null unless BOTH windows have at least one data point,
 * so a sparse channel never shows a misleading delta. days<=0 (all-time) → null.
 */
export function dailyWindowDelta<T extends { day: string }>(
  rows: T[],
  pick: (row: T) => number,
  days: number,
  now = Date.now(),
): MetricDelta | null {
  const pair = splitDailyWindows(rows, pick, days, now);
  return pair ? pctDelta(pair.current.total, pair.previous.total) : null;
}

/**
 * Average reach (views per post) for the current and previous equal-length windows. Per-post
 * averages have no daily archive, so this is post-derived: null unless BOTH windows hold at
 * least one post (a sparse channel gets no comparison rather than a misleading one). Shared by
 * {@link avgReachWindowDelta} and the compact Overview avg-reach card so the delta and the
 * current/previous bars can never quote different windows.
 */
export function avgReachWindows(
  posts: { date?: string | null; views: number }[],
  days: number,
  now = Date.now(),
): { current: number; previous: number; ranges: { current: WindowRange; previous: WindowRange } } | null {
  if (!Number.isFinite(days) || days <= 0) return null;

  const currentStart = now - days * DAY_MS;
  const previousStart = now - days * 2 * DAY_MS;

  let currentViews = 0;
  let currentCount = 0;
  let previousViews = 0;
  let previousCount = 0;

  for (const post of posts) {
    const timestamp = post.date ? Date.parse(post.date) : Number.NaN;
    if (!Number.isFinite(timestamp) || timestamp > now) continue;
    const views = Number(post.views);
    if (!Number.isFinite(views)) continue;
    if (timestamp >= currentStart) {
      currentViews += views;
      currentCount += 1;
    } else if (timestamp >= previousStart) {
      previousViews += views;
      previousCount += 1;
    }
  }

  if (currentCount === 0 || previousCount === 0) return null;
  return {
    current: currentViews / currentCount,
    previous: previousViews / previousCount,
    // Те же скользящие окна, что у sumPostWindows — читатель дельты должен видеть их границы.
    ranges: {
      current: { from: currentStart, to: now },
      previous: { from: previousStart, to: currentStart - 1 },
    },
  };
}

/**
 * Δ of average reach (views per post) between the current and previous windows. Post-derived
 * (no daily archive), so null unless BOTH windows hold at least one post.
 */
export function avgReachWindowDelta(
  posts: { date?: string | null; views: number }[],
  days: number,
  now = Date.now(),
): MetricDelta | null {
  const windows = avgReachWindows(posts, days, now);
  return windows ? pctDelta(windows.current, windows.previous) : null;
}
