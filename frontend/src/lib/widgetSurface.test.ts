import { describe, expect, it } from 'vitest';
import type { WidgetViz } from '@/lib/widgetMetrics';
import {
  coerceSizeForViz,
  effectiveTinted,
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
