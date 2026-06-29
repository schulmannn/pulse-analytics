export interface MetricDelta {
  pct: number;
  dir: 'up' | 'down' | 'flat';
}

export interface DatedPostMetrics {
  date?: string | null;
  views: number;
  reactions: number;
  forwards: number;
  replies: number;
}

export interface PostWindowTotals {
  current: Omit<DatedPostMetrics, 'date'>;
  previous: Omit<DatedPostMetrics, 'date'>;
}

export interface SubscriberHistoryRow {
  day: string;
  subscribers?: number | null;
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

  return { current, previous };
}

export function subscriberDelta(
  rows: SubscriberHistoryRow[],
  days: number,
  now = Date.now(),
): MetricDelta | null {
  if (!Number.isFinite(days) || days <= 0) return null;

  const target = now - days * DAY_MS;
  const points = rows
    .filter((row) => row.subscribers != null)
    .map((row) => ({ timestamp: Date.parse(row.day), subscribers: Number(row.subscribers) }))
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

  return pctDelta(latest.subscribers, baseline.subscribers);
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
  if (!Number.isFinite(days) || days <= 0) return null;

  const target = now - days * DAY_MS;
  const points = rows
    .filter((row) => row.subscribers != null)
    .map((row) => ({ timestamp: Date.parse(row.day), subscribers: Number(row.subscribers) }))
    .filter(
      (point) =>
        Number.isFinite(point.timestamp) && point.timestamp <= now && Number.isFinite(point.subscribers),
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  const latest = points.at(-1);
  const baseline = points.filter((point) => point.timestamp <= target).at(-1);
  if (!latest || !baseline) return null;
  return latest.subscribers - baseline.subscribers;
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
  if (!Number.isFinite(days) || days <= 0) return null;

  const currentStart = now - days * DAY_MS;
  const previousStart = now - days * 2 * DAY_MS;

  let current = 0;
  let previous = 0;
  let hasCurrent = false;
  let hasPrevious = false;

  for (const row of rows) {
    const timestamp = Date.parse(row.day);
    if (!Number.isFinite(timestamp) || timestamp > now) continue;
    const value = pick(row);
    if (!Number.isFinite(value)) continue;
    if (timestamp >= currentStart) {
      current += value;
      hasCurrent = true;
    } else if (timestamp >= previousStart) {
      previous += value;
      hasPrevious = true;
    }
  }

  if (!hasCurrent || !hasPrevious) return null;
  return pctDelta(current, previous);
}

/**
 * Δ of average reach (views per post) between the current and previous windows. Per-post
 * averages have no daily archive, so this is post-derived: null unless BOTH windows hold
 * at least one post (a sparse channel shows no pill rather than a misleading one).
 */
export function avgReachWindowDelta(
  posts: { date?: string | null; views: number }[],
  days: number,
  now = Date.now(),
): MetricDelta | null {
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
  return pctDelta(currentViews / currentCount, previousViews / previousCount);
}
