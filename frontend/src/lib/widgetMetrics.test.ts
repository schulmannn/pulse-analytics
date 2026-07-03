import { describe, expect, it } from 'vitest';
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  METRIC_BY_ID,
  WIDGET_METRICS,
  getMetric,
  isMetricId,
  metricsForSource,
  type MetricCategory,
  type WidgetViz,
} from '@/lib/widgetMetrics';
import { DRILL_KEYS } from '@/lib/kpiDerive';

const SOURCES = new Set(['tg', 'ig', 'all']);
const KINDS = new Set(['value', 'series', 'breakdown', 'table']);
const UNITS = new Set(['number', 'percent', 'posts', 'views']);
const VIZ = new Set<WidgetViz>(['kpi', 'line', 'bar', 'donut', 'list', 'rank', 'pivot', 'table', 'ledger']);

describe('widgetMetrics catalogue', () => {
  it('is non-empty and covers both TG and IG', () => {
    expect(WIDGET_METRICS.length).toBeGreaterThan(0);
    expect(WIDGET_METRICS.some((m) => m.source === 'tg')).toBe(true);
    expect(WIDGET_METRICS.some((m) => m.source === 'ig')).toBe(true);
  });

  it('every metric has well-formed required fields', () => {
    for (const m of WIDGET_METRICS) {
      expect(m.id, `id of ${m.label}`).toBeTruthy();
      expect(m.label, `label of ${m.id}`).toBeTruthy();
      expect(SOURCES.has(m.source), `source of ${m.id}`).toBe(true);
      expect(KINDS.has(m.kind), `kind of ${m.id}`).toBe(true);
      expect(UNITS.has(m.unit), `unit of ${m.id}`).toBe(true);
      expect(CATEGORY_ORDER.includes(m.category), `category of ${m.id}`).toBe(true);
    }
  });

  it('ids are unique and source-namespaced', () => {
    const ids = WIDGET_METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of WIDGET_METRICS) {
      if (m.source !== 'all') expect(m.id.startsWith(`${m.source}.`), `${m.id} namespaced`).toBe(true);
    }
  });

  it('every metric has a defaultViz within a non-empty supportedViz', () => {
    for (const m of WIDGET_METRICS) {
      expect(m.supportedViz.length, `supportedViz of ${m.id}`).toBeGreaterThan(0);
      expect(m.supportedViz.every((v) => VIZ.has(v)), `viz vocab of ${m.id}`).toBe(true);
      expect(m.supportedViz, `default ∈ supported for ${m.id}`).toContain(m.defaultViz);
      // no duplicate viz entries
      expect(new Set(m.supportedViz).size).toBe(m.supportedViz.length);
    }
  });

  it('defaultViz fits the kind', () => {
    // value → kpi, table → table (fixed). series → a time viz (line/bar). breakdown → a
    // categorical viz (list/bar/donut) — ordinal breakdowns (weekday/hour) legitimately default
    // to bar/line without a tint-row list, so we don't force `list` on every breakdown.
    const seriesViz: WidgetViz[] = ['line', 'bar'];
    const breakdownViz: WidgetViz[] = ['list', 'bar', 'donut'];
    for (const m of WIDGET_METRICS) {
      if (m.kind === 'value') expect(m.defaultViz).toBe('kpi');
      if (m.kind === 'table') expect(m.defaultViz).toBe('table');
      if (m.kind === 'series') expect(seriesViz, `series default of ${m.id}`).toContain(m.defaultViz);
      if (m.kind === 'breakdown') expect(breakdownViz, `breakdown default of ${m.id}`).toContain(m.defaultViz);
    }
  });

  it('rank/pivot only appear on metrics that declare dimensions', () => {
    for (const m of WIDGET_METRICS) {
      const hasProjection = m.supportedViz.includes('rank') || m.supportedViz.includes('pivot');
      if (hasProjection) expect((m.dimensions ?? []).length, `dims for ${m.id}`).toBeGreaterThan(0);
    }
  });

  it('covers every kpiDerive DrillKey exactly once via drillKey', () => {
    const mapped = WIDGET_METRICS.map((m) => m.drillKey).filter(Boolean);
    for (const key of DRILL_KEYS) {
      expect(mapped.filter((k) => k === key).length, `drillKey ${key}`).toBe(1);
    }
    // No metric claims a drillKey outside the known set.
    for (const k of mapped) expect(DRILL_KEYS).toContain(k);
  });

  it('level series metrics are the subscriber/follower counts', () => {
    const levels = WIDGET_METRICS.filter((m) => m.seriesAgg === 'level').map((m) => m.id).sort();
    expect(levels).toEqual(['ig.followers', 'tg.subscribers']);
  });

  it('METRIC_BY_ID / getMetric / isMetricId round-trip', () => {
    for (const m of WIDGET_METRICS) {
      expect(METRIC_BY_ID[m.id]).toBe(m);
      expect(getMetric(m.id)).toBe(m);
      expect(isMetricId(m.id)).toBe(true);
    }
    expect(getMetric('nope.metric')).toBeUndefined();
    expect(isMetricId('nope.metric')).toBe(false);
    expect(isMetricId(undefined)).toBe(false);
    expect(isMetricId(null)).toBe(false);
  });

  it('metricsForSource returns that source plus any source-agnostic ones', () => {
    const tg = metricsForSource('tg');
    expect(tg.length).toBeGreaterThan(0);
    expect(tg.every((m) => m.source === 'tg' || m.source === 'all')).toBe(true);
    const ig = metricsForSource('ig');
    expect(ig.every((m) => m.source === 'ig' || m.source === 'all')).toBe(true);
    // A known TG metric is not offered under IG and vice-versa.
    expect(tg.some((m) => m.id === 'tg.views')).toBe(true);
    expect(ig.some((m) => m.id === 'tg.views')).toBe(false);
    expect(ig.some((m) => m.id === 'ig.reach')).toBe(true);
  });

  it('exposes a label + order for all four categories', () => {
    const cats: MetricCategory[] = ['growth', 'engagement', 'content', 'audience'];
    for (const c of cats) {
      expect(CATEGORY_LABEL[c]).toBeTruthy();
      expect(CATEGORY_ORDER).toContain(c);
    }
    expect(CATEGORY_ORDER.length).toBe(cats.length);
  });
});
