import { describe, expect, it } from 'vitest';
import { capabilitiesFor, editorSpec } from '@/lib/widgetCapabilities';
import type { WidgetConfig } from '@/lib/widgetConfig';

const cfg = (metricId: string): WidgetConfig => ({ id: 'w', metricId, viz: 'kpi' });

describe('editorSpec — capability model (U6)', () => {
  it('a series metric enables viz/grain/comparison/target/filter', () => {
    const s = editorSpec(cfg('tg.views'));
    expect(s.label).toBe('Просмотры');
    expect(s.capabilities).toMatchObject({ viz: true, grain: true, comparison: true, target: true, filter: true, metric: false });
    expect(s.supportedViz).toContain('line');
    expect(s.filterDims.map((d) => d.id)).toContain('tg.format');
  });

  it('a value/KPI metric enables none of the series controls', () => {
    const s = editorSpec(cfg('tg.er')); // value, supportedViz [kpi], no dims
    expect(s.capabilities).toMatchObject({ viz: false, grain: false, comparison: false, target: false, filter: false });
  });

  it('a breakdown metric enables viz (list/bar/donut) but not grain/comparison/target', () => {
    const s = editorSpec(cfg('tg.emoji'));
    expect(s.capabilities.viz).toBe(true); // list/bar/donut
    expect(s.capabilities.grain).toBe(false);
    expect(s.capabilities.comparison).toBe(false);
    expect(s.capabilities.target).toBe(false);
    // tg.emoji declares POST_DIMS → filter enabled
    expect(s.capabilities.filter).toBe(true);
  });

  it('a legacy widget edits shell-only (all metric-level capabilities off)', () => {
    const s = editorSpec(cfg('legacy:kpi'));
    expect(s.label).toBe('Показатели');
    expect(s.supportedViz).toEqual([]);
    expect(s.filterDims).toEqual([]);
    expect(capabilitiesFor(cfg('legacy:kpi'))).toEqual({ metric: false, viz: false, grain: false, comparison: false, target: false, filter: false });
  });

  it('an unknown metric degrades to no capabilities (no crash)', () => {
    expect(capabilitiesFor(cfg('nope.metric'))).toEqual({ metric: false, viz: false, grain: false, comparison: false, target: false, filter: false });
  });
});
