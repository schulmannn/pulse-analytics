import { describe, expect, it } from 'vitest';
import { breakdownTitles, bucketLabel, effectiveViz, seriesStats, seriesToChart, unitFormat } from '@/lib/widgetRender';
import type { WidgetResult } from '@/lib/resolveWidgetMetric';

describe('bucketLabel', () => {
  it('formats a month key as a localized short month, not the raw key', () => {
    const m = bucketLabel('2026-06');
    expect(typeof m).toBe('string');
    expect(m).not.toBe('2026-06');
    expect(m.length).toBeGreaterThan(0);
  });
  it('formats a day key via the day formatter (non-empty, not the raw ISO)', () => {
    const d = bucketLabel('2026-06-15');
    expect(typeof d).toBe('string');
    expect(d).not.toBe('2026-06-15');
  });
});

describe('unitFormat', () => {
  it('percent → one-decimal percent', () => {
    expect(unitFormat('percent')(6.5)).toBe('6.5%');
    expect(unitFormat('percent')(12)).toBe('12.0%');
  });
  it('views / number / posts → a string', () => {
    expect(typeof unitFormat('views')(1500)).toBe('string');
    expect(typeof unitFormat('number')(42)).toBe('string');
    expect(typeof unitFormat('posts')(7)).toBe('string');
  });
});

describe('seriesToChart', () => {
  it('maps series points to aligned values/labels/titles', () => {
    const result = {
      metricId: 'tg.views',
      kind: 'series',
      unit: 'views',
      series: [
        { date: '2026-06-14', value: 100 },
        { date: '2026-06-15', value: 200 },
      ],
    } as WidgetResult;
    const c = seriesToChart(result);
    expect(c.values).toEqual([100, 200]);
    expect(c.labels).toHaveLength(2);
    expect(c.titles).toHaveLength(2);
    expect(c.titles[0]).toContain(c.labels[0]);
  });
  it('handles a missing series as empty arrays', () => {
    const c = seriesToChart({ metricId: 'x', kind: 'value', unit: 'number' } as WidgetResult);
    expect(c.values).toEqual([]);
    expect(c.labels).toEqual([]);
    expect(c.titles).toEqual([]);
  });
});

describe('seriesStats', () => {
  it('summarises a series as Макс + Среднее (formatted by unit)', () => {
    const result = {
      metricId: 'tg.views', kind: 'series', unit: 'number',
      series: [{ date: 'a', value: 10 }, { date: 'b', value: 30 }, { date: 'c', value: 20 }],
    } as WidgetResult;
    const s = seriesStats(result);
    expect(s.map((x) => x.label)).toEqual(['Макс', 'Среднее']);
    expect(s[0].value).toBe('30'); // max
    expect(s[1].value).toBe('20'); // avg (60/3)
  });
  it('returns nothing for <2 points', () => {
    expect(seriesStats({ metricId: 'x', kind: 'series', unit: 'number', series: [{ date: 'a', value: 5 }] } as WidgetResult)).toEqual([]);
    expect(seriesStats({ metricId: 'x', kind: 'value', unit: 'number' } as WidgetResult)).toEqual([]);
  });
});

describe('breakdownTitles', () => {
  it('uses display when present, else formats the value', () => {
    const result = {
      metricId: 'tg.emoji',
      kind: 'breakdown',
      unit: 'number',
      breakdown: [
        { label: '🔥', value: 30, display: '30' },
        { label: '👍', value: 20 },
      ],
    } as WidgetResult;
    const t = breakdownTitles(result);
    expect(t[0]).toBe('🔥: 30');
    expect(t[1]).toContain('👍: ');
  });
});

describe('effectiveViz — graceful fallback', () => {
  it('keeps the requested viz when the data supports it', () => {
    expect(effectiveViz('line', true, false)).toBe('line');
    expect(effectiveViz('bar', true, false)).toBe('bar');
    expect(effectiveViz('donut', false, true)).toBe('donut');
    expect(effectiveViz('list', false, true)).toBe('list');
    expect(effectiveViz('kpi', false, false)).toBe('kpi');
  });
  it('falls back to the data shape when the requested viz has no data', () => {
    expect(effectiveViz('line', false, true)).toBe('list'); // series viz, only breakdown present
    expect(effectiveViz('donut', true, false)).toBe('line'); // breakdown viz, only series present
    expect(effectiveViz('line', false, false)).toBe('kpi'); // nothing → scalar
  });
  it('maps unsupported viz (rank/pivot/table/ledger) to the data shape', () => {
    expect(effectiveViz('rank', false, true)).toBe('list');
    expect(effectiveViz('pivot', true, false)).toBe('line');
    expect(effectiveViz('table', false, false)).toBe('kpi');
    expect(effectiveViz('ledger', true, false)).toBe('line');
  });
});
