// The DIMENSIONS catalogue (S7) — the categorical attributes a widget can FILTER by. Stage 1 is
// client-side: the resolver filters the already-fetched TG posts before aggregating, so a widget can
// show e.g. «Просмотры, только видео» or «Реакции по будням». Kept pure + React-free (a filter
// predicate over a raw TgPost), so both the resolver and the editor's FilterBuilder read the same
// source of truth.
//
// Only per-POST attributes are filterable client-side (format / weekday) — source / language are
// audience aggregates from the graphs payload, not per-post, so they are not offered as filters here.

import type { TgPost } from '@/api/schemas';
import type { FilterOp, WidgetFilter } from '@/lib/widgetConfig';

export type DimensionSource = 'tg' | 'ig';

export interface DimensionDef {
  id: string;
  label: string;
  source: DimensionSource;
  /** The selectable values (categorical). The predicate still classifies posts outside this list
   *  (e.g. a poll) — they simply never match an `in` over the common set. */
  values: string[];
  /** The post's value for this dimension (null when not derivable, e.g. an undated post). */
  valueOfRaw: (post: TgPost) => string | null;
}

const WD_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** A raw TG post's format bucket (album beats media type), matching the metric-page / breakdown labels. */
export function tgFormatLabel(post: TgPost): string {
  if (Number(post.album_size ?? 0) > 1) return 'Альбом';
  switch (post.media_type) {
    case 'photo':
      return 'Фото';
    case 'video':
      return 'Видео';
    case 'document':
      return 'Файл';
    case 'poll':
      return 'Опрос';
    case 'audio':
      return 'Аудио';
    case 'voice':
      return 'Голос';
    default:
      return 'Текст';
  }
}

/** A raw TG post's weekday label (Monday-first), or null when the post has no valid date. */
export function tgWeekdayLabel(post: TgPost): string | null {
  if (!post.date) return null;
  const t = Date.parse(post.date);
  if (!Number.isFinite(t)) return null;
  return WD_LABELS[(new Date(t).getDay() + 6) % 7];
}

export const DIMENSIONS: DimensionDef[] = [
  {
    id: 'tg.format',
    label: 'Формат',
    source: 'tg',
    values: ['Фото', 'Видео', 'Альбом', 'Файл', 'Текст'],
    valueOfRaw: tgFormatLabel,
  },
  {
    id: 'tg.weekday',
    label: 'День недели',
    source: 'tg',
    values: WD_LABELS,
    valueOfRaw: tgWeekdayLabel,
  },
];

export const DIMENSION_BY_ID: Record<string, DimensionDef> = Object.fromEntries(DIMENSIONS.map((d) => [d.id, d]));

/** The dimensions a metric can filter by, resolved from its `dimensions` id list. */
export function dimensionsFor(ids: string[] | undefined): DimensionDef[] {
  return (ids ?? []).map((id) => DIMENSION_BY_ID[id]).filter((d): d is DimensionDef => !!d);
}

/** Does a value satisfy one filter's operator? Categorical dims use eq/in (membership) and not_in
 *  (exclusion); the numeric/text ops (gt/lt/contains) are accepted by the model but not used by the
 *  current categorical dimensions, so they pass through as no-ops here. */
function opMatches(op: FilterOp, value: string, values: Array<string | number>): boolean {
  const set = values.map(String);
  if (op === 'eq' || op === 'in') return set.includes(value);
  if (op === 'not_in') return !set.includes(value);
  if (op === 'contains') return set.some((v) => value.includes(v));
  return true; // gt / lt — not meaningful for categorical labels
}

/** Does a raw post satisfy ALL of the widget's filters? Unknown dimensions are ignored (pass), so a
 *  stale/foreign filter never silently blanks a widget. An undated post fails an `in`, passes `not_in`. */
export function postMatchesFilters(post: TgPost, filters: WidgetFilter[] | undefined): boolean {
  if (!filters || filters.length === 0) return true;
  return filters.every((f) => {
    const dim = DIMENSION_BY_ID[f.dimensionId];
    if (!dim) return true; // unknown dimension → ignore
    const value = dim.valueOfRaw(post);
    if (value == null) return f.op === 'not_in'; // no value → excluded by include, kept by exclude
    return opMatches(f.op, value, f.values);
  });
}
