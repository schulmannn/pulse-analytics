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

  // Ряд-специфичные контролы у метрики-числа выключены, а ЦЕЛЬ — нет: «хочу ER 45%» такой же
  // понятный ориентир, как цель по просмотрам, и именно она даёт числу честное кольцо прогресса
  // (RadialGauge рисуется для kpi-виджета с целью).
  it('a value/KPI metric enables the goal but none of the series controls', () => {
    const s = editorSpec(cfg('tg.er')); // value, supportedViz [kpi], no dims
    expect(s.capabilities).toMatchObject({ viz: false, grain: false, comparison: false, filter: false });
    expect(s.capabilities.target).toBe(true);
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
    expect(s.supportedViz).toEqual(['kpi']);
    expect(s.capabilities.viz).toBe(false);
    expect(s.filterDims).toEqual([]);
    expect(capabilitiesFor(cfg('legacy:kpi'))).toEqual({ metric: false, viz: false, grain: false, comparison: false, target: false, filter: false });
  });

  it('subscriber history exposes only its canonical total-audience curve', () => {
    const s = editorSpec(cfg('legacy:history'));
    expect(s.supportedViz).toEqual(['line']);
    expect(s.capabilities).toEqual({ metric: false, viz: false, grain: false, comparison: false, target: false, filter: false });
    expect(s.filterDims).toEqual([]);
  });

  it('an unknown metric degrades to no capabilities (no crash)', () => {
    expect(capabilitiesFor(cfg('nope.metric'))).toEqual({ metric: false, viz: false, grain: false, comparison: false, target: false, filter: false });
  });

  it('a value metric carries a disabled-reason for every off control (shown disabled, not hidden)', () => {
    const s = editorSpec(cfg('tg.er')); // value: viz/grain/comparison/filter off, goal ON
    expect(s.disabledReasons?.grain).toBeTruthy();
    expect(s.disabledReasons?.comparison).toBeTruthy();
    expect(s.disabledReasons?.viz).toBeTruthy();
    expect(s.disabledReasons?.filter).toBeTruthy();
    expect(s.disabledReasons?.target).toBeUndefined(); // цель доступна — причины отключения нет
  });

  it('a fully-enabled series metric has no disabled reasons', () => {
    expect(editorSpec(cfg('tg.views')).disabledReasons ?? {}).toEqual({});
  });

  it('a legacy widget carries no disabledReasons (bare shell, not disabled clutter)', () => {
    expect(editorSpec(cfg('legacy:kpi')).disabledReasons).toBeUndefined();
  });
});
