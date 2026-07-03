import { describe, expect, it } from 'vitest';
import {
  DIMENSIONS,
  DIMENSION_BY_ID,
  dimensionsFor,
  postMatchesFilters,
  tgFormatLabel,
  tgWeekdayLabel,
} from '@/lib/dimensions';
import type { TgPost } from '@/api/schemas';
import type { WidgetFilter } from '@/lib/widgetConfig';

const post = (p: Partial<TgPost>): TgPost => p as TgPost;

describe('tgFormatLabel', () => {
  it('classifies by media type, album beats type', () => {
    expect(tgFormatLabel(post({ media_type: 'photo' }))).toBe('Фото');
    expect(tgFormatLabel(post({ media_type: 'video' }))).toBe('Видео');
    expect(tgFormatLabel(post({ media_type: 'document' }))).toBe('Файл');
    expect(tgFormatLabel(post({ media_type: 'photo', album_size: 4 }))).toBe('Альбом');
    expect(tgFormatLabel(post({}))).toBe('Текст');
  });
});

describe('tgWeekdayLabel', () => {
  it('returns a Monday-first weekday label, or null when undated', () => {
    // 2026-06-15 is a Monday.
    expect(tgWeekdayLabel(post({ date: '2026-06-15T12:00:00Z' }))).toBe('Пн');
    expect(tgWeekdayLabel(post({ date: null }))).toBeNull();
    expect(tgWeekdayLabel(post({ date: 'not-a-date' }))).toBeNull();
  });
});

describe('DIMENSIONS catalogue', () => {
  it('exposes tg.format and tg.weekday with values + a lookup', () => {
    expect(DIMENSIONS.map((d) => d.id)).toContain('tg.format');
    expect(DIMENSION_BY_ID['tg.weekday'].values).toHaveLength(7);
    expect(dimensionsFor(['tg.format', 'nope.dim']).map((d) => d.id)).toEqual(['tg.format']);
    expect(dimensionsFor(undefined)).toEqual([]);
  });
});

describe('postMatchesFilters', () => {
  const video = post({ media_type: 'video', date: '2026-06-15T12:00:00Z' }); // Monday
  const photo = post({ media_type: 'photo', date: '2026-06-16T12:00:00Z' }); // Tuesday
  const f = (dimensionId: string, op: WidgetFilter['op'], values: string[]): WidgetFilter => ({ dimensionId, op, values });

  it('passes everything with no filters', () => {
    expect(postMatchesFilters(video, [])).toBe(true);
    expect(postMatchesFilters(video, undefined)).toBe(true);
  });

  it('applies an include (in) filter', () => {
    expect(postMatchesFilters(video, [f('tg.format', 'in', ['Видео'])])).toBe(true);
    expect(postMatchesFilters(photo, [f('tg.format', 'in', ['Видео'])])).toBe(false);
  });

  it('applies an exclude (not_in) filter', () => {
    expect(postMatchesFilters(video, [f('tg.format', 'not_in', ['Видео'])])).toBe(false);
    expect(postMatchesFilters(photo, [f('tg.format', 'not_in', ['Видео'])])).toBe(true);
  });

  it('ANDs multiple filters across dimensions', () => {
    const both = [f('tg.format', 'in', ['Видео']), f('tg.weekday', 'in', ['Пн'])];
    expect(postMatchesFilters(video, both)).toBe(true); // video AND Monday
    expect(postMatchesFilters(photo, both)).toBe(false); // photo fails format
    const monVideoTue = post({ media_type: 'video', date: '2026-06-16T12:00:00Z' }); // video, Tuesday
    expect(postMatchesFilters(monVideoTue, both)).toBe(false); // fails weekday
  });

  it('ignores an unknown dimension (never silently blanks)', () => {
    expect(postMatchesFilters(video, [f('nope.dim', 'in', ['x'])])).toBe(true);
  });

  it('an undated post fails an include but passes an exclude on weekday', () => {
    const undated = post({ media_type: 'video', date: null });
    expect(postMatchesFilters(undated, [f('tg.weekday', 'in', ['Пн'])])).toBe(false);
    expect(postMatchesFilters(undated, [f('tg.weekday', 'not_in', ['Пн'])])).toBe(true);
  });
});
