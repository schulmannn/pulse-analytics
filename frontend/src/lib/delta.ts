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
