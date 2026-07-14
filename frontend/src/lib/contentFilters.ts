import type { NormalizedPost } from '@/lib/posts';
import { DEFAULT_WIDGET_DAYS, type PeriodDays } from '@/lib/period';

/**
 * URL-BACKED CONTENT FILTERS — the single, testable owner of the Telegram «Контент» page's
 * reproducible view state. The page serialises exactly five params into its URL:
 *   period=7|30|90|all · q=<text> · format=all|text|photo|video|album · sort=<col> · order=asc|desc
 * plus the pre-existing `campaign`/`view` params, which compose untouched. Defaults are OMITTED
 * from the URL (a clean link), and every param normalises safely to its default on garbage input,
 * so a hand-edited or stale deep link can never wedge the page.
 *
 * This module is pure (no React, no DOM beyond URLSearchParams) so the parse → filter → sort
 * pipeline is unit-testable end to end; the panel only wires it to `useSearchParams`.
 */

export type ContentFormat = 'all' | 'text' | 'photo' | 'video' | 'album';
export type ContentSort = 'date' | 'reach' | 'likes' | 'shares' | 'virality' | 'erv' | 'er';
export type SortOrder = 'asc' | 'desc';

export interface ContentFilters {
  period: PeriodDays;
  q: string;
  format: ContentFormat;
  sort: ContentSort;
  order: SortOrder;
}

export const CONTENT_DEFAULTS: ContentFilters = {
  period: 30,
  q: '',
  format: 'all',
  sort: 'reach',
  order: 'desc',
};

const FORMATS: ReadonlySet<string> = new Set<ContentFormat>(['all', 'text', 'photo', 'video', 'album']);

/** Parse the Content-only `?period=` scheme. It intentionally differs from metric/report `?p=`. */
export function parseContentPeriod(raw: string | null | undefined): PeriodDays {
  if (raw === 'all') return 0;
  if (raw === '7') return 7;
  if (raw === '90') return 90;
  return DEFAULT_WIDGET_DAYS;
}

/** Serialize a Content period, omitting the default 30-day window from clean URLs. */
export function serializeContentPeriod(days: PeriodDays): string | null {
  if (days === DEFAULT_WIDGET_DAYS) return null;
  return days === 0 ? 'all' : String(days);
}

function postTimestamp(post: NormalizedPost): number | null {
  if (!post.date) return null;
  const timestamp = Date.parse(post.date);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Sortable columns — the metric getter is the single source of truth for both header and sort. A
    `null` metric sinks to the bottom of a descending sort (treated as -∞) so «—» rows never top it. */
export const CONTENT_SORT_COLUMNS: {
  key: ContentSort;
  label: string;
  get: (p: NormalizedPost) => number | null;
}[] = [
  { key: 'date', label: 'Дата', get: postTimestamp },
  { key: 'reach', label: 'Просмотры', get: (p) => p.reach },
  { key: 'likes', label: 'Реакции', get: (p) => p.likes },
  { key: 'shares', label: 'Репосты', get: (p) => p.shares ?? 0 },
  { key: 'virality', label: 'Виральность', get: (p) => p.virality },
  { key: 'erv', label: 'ERV', get: (p) => p.erv },
  { key: 'er', label: 'ER', get: (p) => p.er },
];

const SORT_KEYS: ReadonlySet<string> = new Set(CONTENT_SORT_COLUMNS.map((c) => c.key));

/** Parse all five Content params out of a URLSearchParams. Every field normalises to its default on
    missing/invalid input — the result is always a fully-populated, valid ContentFilters. */
export function parseContentFilters(params: URLSearchParams): ContentFilters {
  const rawFormat = params.get('format');
  const rawSort = params.get('sort');
  const rawOrder = params.get('order');
  return {
    period: parseContentPeriod(params.get('period')),
    // Keep the raw value while the user types: trimming here makes an inter-word space disappear
    // on the next URL-driven render, so a phrase such as "product launch" cannot be entered.
    q: params.get('q') ?? '',
    format: rawFormat && FORMATS.has(rawFormat) ? (rawFormat as ContentFormat) : CONTENT_DEFAULTS.format,
    sort: rawSort && SORT_KEYS.has(rawSort) ? (rawSort as ContentSort) : CONTENT_DEFAULTS.sort,
    order: rawOrder === 'asc' ? 'asc' : CONTENT_DEFAULTS.order,
  };
}

/**
 * Write a ContentFilters onto a COPY of `prev` (preserving `campaign`, `view` and any unrelated
 * params), omitting every default so the URL stays minimal. Returns a new URLSearchParams — the
 * caller passes it to `setSearchParams`. Merge-and-replace idiom, matching `?campaign=`/`?tab=`.
 */
export function applyContentFilters(prev: URLSearchParams, filters: ContentFilters): URLSearchParams {
  const next = new URLSearchParams(prev);

  const period = serializeContentPeriod(filters.period);
  if (period == null) next.delete('period');
  else next.set('period', period);

  if (filters.q.trim() === CONTENT_DEFAULTS.q) next.delete('q');
  else next.set('q', filters.q);

  if (filters.format === CONTENT_DEFAULTS.format) next.delete('format');
  else next.set('format', filters.format);

  if (filters.sort === CONTENT_DEFAULTS.sort) next.delete('sort');
  else next.set('sort', filters.sort);

  if (filters.order === CONTENT_DEFAULTS.order) next.delete('order');
  else next.set('order', filters.order);

  return next;
}

/**
 * Honest media-format bucket derived from NormalizedPost fields. Buckets are mutually exclusive by
 * precedence: an album (albumSize > 1) is an album regardless of its item media type, then video,
 * then photo, else text. `classifyFormat(p) === format` is the whole filter predicate.
 */
export function classifyFormat(post: NormalizedPost): Exclude<ContentFormat, 'all'> {
  if (post.albumSize > 1) return 'album';
  if (post.mediaType === 'video') return 'video';
  if (post.mediaType === 'photo') return 'photo';
  return 'text';
}

/** Case-insensitive match over caption + hashtags. An empty/whitespace query matches everything. */
export function matchesQuery(post: NormalizedPost, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (post.caption.toLowerCase().includes(needle)) return true;
  return post.hashtags.some((tag) => tag.toLowerCase().includes(needle));
}

/** Apply the format + text-search predicates (period windowing is the caller's job — it needs the
    live page period). Preserves input order; sorting is a separate, explicit step. */
export function filterPosts(
  posts: NormalizedPost[],
  opts: { q: string; format: ContentFormat },
): NormalizedPost[] {
  return posts.filter(
    (p) =>
      (opts.format === 'all' || classifyFormat(p) === opts.format) && matchesQuery(p, opts.q),
  );
}

/**
 * Stable sort by the chosen column/direction. Missing metrics always stay at the bottom in both
 * directions; reversing a sort must not promote rows that have no value. Ties keep input order.
 */
export function sortPosts(
  posts: NormalizedPost[],
  sort: ContentSort,
  order: SortOrder,
): NormalizedPost[] {
  const col = CONTENT_SORT_COLUMNS.find((c) => c.key === sort) ?? CONTENT_SORT_COLUMNS[1]!;
  const dir = order === 'asc' ? 1 : -1;
  return [...posts].sort((a, b) => {
    const av = col.get(a);
    const bv = col.get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * dir;
  });
}
