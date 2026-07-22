import type { IgPost } from '@/api/schemas';

/**
 * URL-BACKED INSTAGRAM CONTENT FILTERS — the pure, testable owner of the desktop IG «Публикации»
 * table's reproducible view state, the IG twin of {@link import('./contentFilters')}.
 *
 * IMPORTANT: unlike the Telegram module, this one does NOT own a period. The IG content page's
 * window is owned by the IgFeed page-period control and materialised as `ig.postsInWindow`
 * (see useIgData) — inventing a second period owner here would fork the window. So this module
 * serialises exactly FOUR post-table params plus ONE secondary-view param:
 *   q=<text> · format=all|photo|video|carousel|reels · sort=<col> · order=asc|desc · more=<view>
 * and composes untouched with the pre-existing `campaign`/`view`/`period` params. Defaults are
 * OMITTED from the URL (a clean link), and every param normalises safely to its default on garbage
 * input, so a hand-edited or stale deep link can never wedge the page.
 *
 * Pure (no React, no DOM beyond URLSearchParams) so the parse → filter → sort pipeline and the
 * median-honesty getters are unit-testable end to end; the panel only wires it to useSearchParams.
 */

export type IgContentFormat = 'all' | 'photo' | 'video' | 'carousel' | 'reels';
export type IgContentSort = 'date' | 'reach' | 'views' | 'interactions' | 'saved' | 'shares' | 'er';
/**
 * The sort SELECTION also models the explicit third state — `'none'` — reached by cycling an active
 * column past `asc`. In that state the table preserves the filtered input order (no column is sorted
 * or marked aria-sort). Only real columns ({@link IgContentSort}) ever carry a direction.
 */
export type IgContentSortSelection = IgContentSort | 'none';
export type SortOrder = 'asc' | 'desc';
export const IG_CONTENT_SORT_NONE = 'none' as const;

/** The secondary analyses the desktop table hides behind a compact tab control (task 5). */
export type IgSecondaryView = 'formats' | 'reels' | 'hashtags' | 'stories' | 'tags';
export const IG_SECONDARY_VIEWS: readonly IgSecondaryView[] = ['formats', 'reels', 'hashtags', 'stories', 'tags'];
/** The default secondary tab — omitted from a clean URL. */
export const IG_SECONDARY_DEFAULT: IgSecondaryView = 'formats';
const SECONDARY_SET: ReadonlySet<string> = new Set(IG_SECONDARY_VIEWS);

export interface IgContentFilters {
  q: string;
  format: IgContentFormat;
  sort: IgContentSortSelection;
  order: SortOrder;
}

export const IG_CONTENT_DEFAULTS: IgContentFilters = {
  q: '',
  format: 'all',
  sort: 'reach',
  order: 'desc',
};

const FORMATS: ReadonlySet<string> = new Set<IgContentFormat>(['all', 'photo', 'video', 'carousel', 'reels']);

/** Coerce an optional metric field to a real finite number, or null when it is absent/garbage. */
function num(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(v) ? null : v;
}

/**
 * Honest interaction total for one post. Prefers the API's `total_interactions`; falls back to the
 * component sum (likes + comments + saved + shares). Returns null only when NONE of those fields is
 * present — so a truly empty post reads as «—», never a fake 0.
 */
export function igInteractions(p: IgPost): number | null {
  const ti = num(p.total_interactions);
  const parts = [num(p.like_count), num(p.comments_count), num(p.saved), num(p.shares)];
  const hasParts = parts.some((x) => x != null);
  // Match the repository's canonical postEr fallback: Graph can occasionally return a stale
  // zero total alongside populated component metrics. A real zero with no components stays zero.
  if (ti != null && (ti !== 0 || !hasParts)) return ti;
  if (!hasParts) return null;
  return parts.reduce((acc: number, x) => acc + (x ?? 0), 0);
}

/**
 * Engagement rate for one post using the repo's IG semantics (interactions ÷ reach), matching
 * {@link postEr}. Returns null when reach is missing/≤0 or interactions are absent — an honest
 * «—» instead of a divide-by-zero 0%. postEr is the numeric formula of record; this only adds the
 * null gate the table/median math needs.
 */
export function igEr(p: IgPost): number | null {
  const reach = num(p.reach);
  if (reach == null || reach <= 0) return null;
  const interactions = igInteractions(p);
  if (interactions == null) return null;
  return (interactions / reach) * 100;
}

/**
 * Honest, mutually-exclusive media-format bucket. Precedence: a Reel (media_product_type REELS)
 * is a Reel regardless of media_type; then carousel, then video, else photo. Every real IG post
 * lands in exactly one bucket, so `classifyIgFormat(p) === format` is the whole filter predicate.
 */
export function classifyIgFormat(p: IgPost): Exclude<IgContentFormat, 'all'> {
  if (p.media_product_type === 'REELS') return 'reels';
  const mt = p.media_type;
  if (mt === 'CAROUSEL_ALBUM') return 'carousel';
  if (mt === 'VIDEO') return 'video';
  return 'photo';
}

function postTimestamp(p: IgPost): number | null {
  const t = Date.parse(p.timestamp ?? '');
  return Number.isFinite(t) ? t : null;
}

/** Hashtags derived from the caption (IG has no structured tag field) — same regex as hashtagStats. */
export function igHashtags(p: IgPost): string[] {
  return (p.caption ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? [];
}

/**
 * Sortable columns — the metric getter is the single source of truth for header, sort AND the
 * median comparison. A `null` metric is «missing» and always sinks to the bottom (see sortIgPosts).
 */
export const IG_CONTENT_SORT_COLUMNS: {
  key: IgContentSort;
  label: string;
  get: (p: IgPost) => number | null;
}[] = [
  { key: 'date', label: 'Дата', get: postTimestamp },
  { key: 'reach', label: 'Охват', get: (p) => num(p.reach) },
  { key: 'views', label: 'Просмотры', get: (p) => num(p.views) },
  { key: 'interactions', label: 'Взаимодействия', get: igInteractions },
  { key: 'saved', label: 'Сохранения', get: (p) => num(p.saved) },
  { key: 'shares', label: 'Репосты', get: (p) => num(p.shares) },
  { key: 'er', label: 'ER', get: igEr },
];

const SORT_KEYS: ReadonlySet<string> = new Set(IG_CONTENT_SORT_COLUMNS.map((c) => c.key));

/** Parse the four table params out of a URLSearchParams; every field normalises to its default on
    missing/invalid input — the result is always a fully-populated, valid IgContentFilters. */
export function parseIgContentFilters(params: URLSearchParams): IgContentFilters {
  const rawFormat = params.get('format');
  const rawSort = params.get('sort');
  const rawOrder = params.get('order');
  return {
    // Keep the raw value while the user types (see TG contentFilters): trimming here would drop an
    // inter-word space on the next URL-driven render, blocking a multi-word phrase.
    q: params.get('q') ?? '',
    format: rawFormat && FORMATS.has(rawFormat) ? (rawFormat as IgContentFormat) : IG_CONTENT_DEFAULTS.format,
    // `sort=none` is the explicit no-sort third state; any other unknown value falls back to default.
    sort:
      rawSort === IG_CONTENT_SORT_NONE
        ? IG_CONTENT_SORT_NONE
        : rawSort && SORT_KEYS.has(rawSort)
          ? (rawSort as IgContentSort)
          : IG_CONTENT_DEFAULTS.sort,
    order: rawOrder === 'asc' ? 'asc' : IG_CONTENT_DEFAULTS.order,
  };
}

/** Parse the `?more=` secondary-view param, defaulting to IG_SECONDARY_DEFAULT on missing/garbage. */
export function parseIgSecondaryView(raw: string | null | undefined): IgSecondaryView {
  return raw && SECONDARY_SET.has(raw) ? (raw as IgSecondaryView) : IG_SECONDARY_DEFAULT;
}

/**
 * Write a IgContentFilters onto a COPY of `prev` (preserving `campaign`, `view`, `period`, `more`
 * and any unrelated params), omitting every default so the URL stays minimal. Merge-and-replace
 * idiom, matching `?campaign=`/`?view=`.
 */
export function applyIgContentFilters(prev: URLSearchParams, filters: IgContentFilters): URLSearchParams {
  const next = new URLSearchParams(prev);

  if (filters.q.trim() === IG_CONTENT_DEFAULTS.q) next.delete('q');
  else next.set('q', filters.q);

  if (filters.format === IG_CONTENT_DEFAULTS.format) next.delete('format');
  else next.set('format', filters.format);

  if (filters.sort === IG_CONTENT_DEFAULTS.sort) next.delete('sort');
  else next.set('sort', filters.sort);

  // In the no-sort state the direction is meaningless — never serialise a stray `order`.
  if (filters.sort === IG_CONTENT_SORT_NONE || filters.order === IG_CONTENT_DEFAULTS.order) next.delete('order');
  else next.set('order', filters.order);

  return next;
}

/** Write the `?more=` secondary-view param onto a copy of `prev`, omitting the default. */
export function applyIgSecondaryView(prev: URLSearchParams, view: IgSecondaryView): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (view === IG_SECONDARY_DEFAULT) next.delete('more');
  else next.set('more', view);
  return next;
}

/** Case-insensitive match over caption + caption hashtags. An empty/whitespace query matches all. */
export function matchesIgQuery(p: IgPost, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if ((p.caption ?? '').toLowerCase().includes(needle)) return true;
  return igHashtags(p).some((tag) => tag.toLowerCase().includes(needle));
}

/** Apply the format + text-search predicates (period windowing is the caller's job — it belongs to
    ig.postsInWindow). Preserves input order; sorting is a separate, explicit step. */
export function filterIgPosts(
  posts: IgPost[],
  opts: { q: string; format: IgContentFormat },
): IgPost[] {
  return posts.filter(
    (p) => (opts.format === 'all' || classifyIgFormat(p) === opts.format) && matchesIgQuery(p, opts.q),
  );
}

/**
 * Stable sort by the chosen column/direction. The `'none'` selection preserves the filtered input
 * order exactly (a shallow copy — never mutates the caller's array). Missing metrics (null) always
 * stay at the bottom in BOTH directions; reversing a sort must not promote rows that have no value.
 * Ties keep input order (Array.prototype.sort is stable), so the default reach-desc order is
 * deterministic.
 */
export function sortIgPosts(posts: IgPost[], sort: IgContentSortSelection, order: SortOrder): IgPost[] {
  if (sort === IG_CONTENT_SORT_NONE) return [...posts];
  const col = IG_CONTENT_SORT_COLUMNS.find((c) => c.key === sort) ?? IG_CONTENT_SORT_COLUMNS[1]!;
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
