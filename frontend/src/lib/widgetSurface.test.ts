import { describe, expect, it } from 'vitest';
import type { WidgetViz } from '@/lib/widgetMetrics';
import {
  coerceSizeForViz,
  defaultWidgetTint,
  effectiveTinted,
  resolveWidgetTint,
  vizAllowsThirdWidth,
  vizAllowsTonalSurface,
} from '@/lib/widgetSurface';

const ALL_VIZ: WidgetViz[] = ['kpi', 'line', 'bar', 'donut', 'list', 'rank', 'pivot', 'table', 'ledger'];

describe('surface policy', () => {
  it('allows a tonal surface only for the single-metric story vizzes (kpi, line)', () => {
    expect(vizAllowsTonalSurface('kpi')).toBe(true);
    expect(vizAllowsTonalSurface('line')).toBe(true);
    for (const viz of ['bar', 'donut', 'list', 'rank', 'pivot', 'table', 'ledger'] as WidgetViz[]) {
      expect(vizAllowsTonalSurface(viz)).toBe(false);
    }
  });

  it('forces multi-series/tabular vizzes neutral regardless of the saved accent', () => {
    // Saved "tinted" preference is honoured for a story viz…
    expect(effectiveTinted('kpi', true)).toBe(true);
    expect(effectiveTinted('line', undefined)).toBe(true); // default-on
    // …but overridden to neutral for everything else, even when the user saved tinted=true.
    expect(effectiveTinted('bar', true)).toBe(false);
    expect(effectiveTinted('donut', true)).toBe(false);
    expect(effectiveTinted('list', true)).toBe(false);
    expect(effectiveTinted('table', true)).toBe(false);
  });

  it('never turns a story viz tonal when the user explicitly opted out', () => {
    expect(effectiveTinted('kpi', false)).toBe(false);
    expect(effectiveTinted('line', false)).toBe(false);
  });

  it('дефолт тинта у карточки С ОБЪЯВЛЕННЫМ ХОСТОМ акцентом объявляет хост, у карточки БЕЗ него — включён', () => {
    // Первый аргумент — `defaultColor` из JSX хоста, а НЕ эффективный акцент карточки.
    // Хост объявил акцент: доска из пяти заливок обесценивает цвет, поэтому по умолчанию —
    // нейтрально, и только объявленная хостом история несёт заливку.
    expect(defaultWidgetTint(1, undefined)).toBe(false);
    expect(defaultWidgetTint(1, false)).toBe(false);
    expect(defaultWidgetTint(1, true)).toBe(true);
    // Хост акцента не объявил: `--card-tint`-подложка — базовая поверхность карточки, а не история.
    expect(defaultWidgetTint(undefined, undefined)).toBe(true);
    expect(defaultWidgetTint(undefined, false)).toBe(true);
  });

  it('сохранённый выбор пользователя главнее дефолта хоста — смена дефолта не перекрашивает карточку', () => {
    // Хост объявил историю тонированной, пользователь снял заливку руками → заливки нет.
    expect(resolveWidgetTint(false, 1, true)).toBe(false);
    // Хост оставил дефолт нейтральным, пользователь включил заливку сам → заливка есть.
    expect(resolveWidgetTint(true, 1, undefined)).toBe(true);
    expect(resolveWidgetTint(true, 1, false)).toBe(true);
    // Та же независимость у карточки без акцента: снятая руками подложка остаётся снятой.
    expect(resolveWidgetTint(false, undefined, undefined)).toBe(false);
    expect(resolveWidgetTint(true, undefined, undefined)).toBe(true);
  });

  it('без сохранённого выбора тинт падает в дефолт хоста', () => {
    expect(resolveWidgetTint(undefined, 1, undefined)).toBe(false);
    expect(resolveWidgetTint(undefined, 1, true)).toBe(true);
    expect(resolveWidgetTint(undefined, undefined, undefined)).toBe(true);
  });

  it('свой акцент, выбранный свотчем, НЕ снимает заливку: дефолт считается от акцента хоста', () => {
    // Свотч в EditWidgetDialog пишет только `color`, `tinted` остаётся undefined. У карточки без
    // объявленного хостом акцента (напр. «Просмотры и репосты» в TgAnalytics) заливка раньше была
    // и обязана остаться — дефолт смотрит на `defaultColor` хоста (здесь undefined), а не на
    // сохранённый цвет пользователя.
    expect(resolveWidgetTint(undefined, undefined, undefined)).toBe(true);
    // А у карточки, чей акцент объявил хост, дефолт по-прежнему нейтральный.
    expect(resolveWidgetTint(undefined, 3, undefined)).toBe(false);
  });
});

describe('width policy', () => {
  it('forbids a temporal line at third width, allows every other viz there', () => {
    expect(vizAllowsThirdWidth('line')).toBe(false);
    for (const viz of ALL_VIZ.filter((v) => v !== 'line')) {
      expect(vizAllowsThirdWidth(viz)).toBe(true);
    }
  });

  it('coerces a third-width temporal line up to half, without touching valid sizes', () => {
    expect(coerceSizeForViz('line', 'third')).toBe('half');
    expect(coerceSizeForViz('line', 'half')).toBe('half');
    expect(coerceSizeForViz('line', 'full')).toBe('full');
  });

  it('leaves compact vizzes at third width', () => {
    expect(coerceSizeForViz('kpi', 'third')).toBe('third');
    expect(coerceSizeForViz('bar', 'third')).toBe('third');
    expect(coerceSizeForViz('donut', 'third')).toBe('third');
  });
});
