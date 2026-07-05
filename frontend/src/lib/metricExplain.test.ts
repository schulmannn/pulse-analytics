import { describe, it, expect } from 'vitest';
import { explainRows, sampleText, metricLabel } from './metricExplain';
import type { WidgetMeta } from './resolveWidgetMetric';

describe('sampleText', () => {
  it('pluralises in-window posts, else archive days, else null', () => {
    expect(sampleText({ samplePosts: 1 })).toBe('1 пост');
    expect(sampleText({ samplePosts: 3 })).toBe('3 поста');
    expect(sampleText({ samplePosts: 12 })).toBe('12 постов');
    expect(sampleText({ archiveDays: 30 })).toBe('30 дн. в архиве');
    // posts take precedence over archive when both are present
    expect(sampleText({ samplePosts: 5, archiveDays: 30 })).toBe('5 постов');
    expect(sampleText({ samplePosts: 0 })).toBeNull();
    expect(sampleText(undefined)).toBeNull();
  });
});

describe('explainRows', () => {
  it('composes STATIC catalogue definition with DYNAMIC meta, in order', () => {
    const meta: WidgetMeta = {
      periodLabel: 'за 30 дн.',
      samplePosts: 12,
      fresh: { label: '2 дня назад', stale: false },
      comparisonNote: 'сравнение скрыто — недостаточно истории постов',
    };
    const rows = explainRows('tg.views', meta);
    const labels = rows.map((r) => r.label);
    // static (formula → source) precedes dynamic (period → sample → freshness → comparison)
    expect(labels).toEqual(['Как считается', 'Источник', 'Период', 'Выборка', 'Данные', 'Сравнение']);
    expect(rows.find((r) => r.label === 'Выборка')?.text).toBe('12 постов');
    // a suppressed comparison is always a warn (data-quality caution)
    expect(rows.find((r) => r.label === 'Сравнение')?.warn).toBe(true);
    // fresh, not stale → no warn
    expect(rows.find((r) => r.label === 'Данные')?.warn).toBe(false);
  });

  it('marks stale data with the warn tone', () => {
    const rows = explainRows('tg.views', { fresh: { label: '9 дней назад', stale: true } });
    expect(rows.find((r) => r.label === 'Данные')?.warn).toBe(true);
  });

  it('static-only when there is no meta (formula/source still explain the card)', () => {
    const labels = explainRows('tg.views', undefined).map((r) => r.label);
    expect(labels).toContain('Как считается');
    expect(labels).toContain('Источник');
    expect(labels).not.toContain('Период');
  });

  it('dynamic-only for an unknown metric id (no catalogue entry)', () => {
    const rows = explainRows('legacy.unknown', { periodLabel: 'за 7 дн.' });
    expect(rows.map((r) => r.label)).toEqual(['Период']);
  });

  it('empty when there is nothing to explain', () => {
    expect(explainRows(undefined, undefined)).toEqual([]);
    expect(explainRows('legacy.unknown', undefined)).toEqual([]);
  });
});

describe('metricLabel', () => {
  it('returns the catalogue label, else a generic fallback', () => {
    expect(metricLabel('tg.views')).toBe('Просмотры');
    expect(metricLabel('legacy.unknown')).toBe('Метрика');
    expect(metricLabel(undefined)).toBe('Метрика');
  });
});
