import { describe, expect, it } from 'vitest';
import {
  HOME_KPI_SPLIT,
  HOME_KPI_SPLIT_METRIC_IDS,
  homeKpiInheritedShell,
  homeKpiSplitConfig,
  homeKpiSplitConfigId,
  homeKpiSplitConfigs,
  homeKpiSplitCustomKey,
  homeKpiSplitOrderToken,
  homeKpiSplitTargets,
  isHomeKpiSplitConfigId,
  isLegacyKpiHomeKey,
  splitKpiInGroupOrder,
  splitKpiInHomeKeys,
} from '@/lib/homeKpiSplit';
import { customKey } from '@/lib/widgetConfig';
import { getMetric } from '@/lib/widgetMetrics';

describe('HOME_KPI_SPLIT spec', () => {
  it('is the five Overview KPI metrics with the requested S/M footprints', () => {
    expect(HOME_KPI_SPLIT.map((s) => [s.metricId, s.size])).toEqual([
      ['tg.views', 'half'], // M
      ['tg.subscribers', 'half'], // M
      ['tg.avgReach', 'third'], // S
      ['tg.reactions', 'third'], // S
      ['tg.er', 'third'], // S
    ]);
    expect(HOME_KPI_SPLIT_METRIC_IDS).toEqual(['tg.views', 'tg.subscribers', 'tg.avgReach', 'tg.reactions', 'tg.er']);
  });

  it('every split metric exists in the catalogue and supports its chosen viz', () => {
    for (const spec of HOME_KPI_SPLIT) {
      const metric = getMetric(spec.metricId);
      expect(metric, spec.metricId).toBeTruthy();
      expect(metric!.supportedViz).toContain(spec.viz);
    }
  });

  it('the S series cards use a viz that survives third width (not a temporal line)', () => {
    // A temporal LINE is coerced up from third by the width policy — the S cards must not be line.
    for (const spec of HOME_KPI_SPLIT.filter((s) => s.size === 'third')) {
      expect(spec.viz).not.toBe('line');
    }
  });
});

describe('deterministic ids', () => {
  it('derives a stable config id / custom key / order token from the metric id', () => {
    expect(homeKpiSplitConfigId('tg.views')).toBe('home-kpi-tg-views');
    expect(homeKpiSplitConfigId('tg.er')).toBe('home-kpi-tg-er');
    expect(homeKpiSplitCustomKey('tg.views')).toBe(customKey('home-kpi-tg-views'));
    expect(homeKpiSplitOrderToken('tg.views')).toBe('custom-home-kpi-tg-views');
    expect(isHomeKpiSplitConfigId('home-kpi-tg-views')).toBe(true);
    expect(isHomeKpiSplitConfigId('legacy-kpi')).toBe(false);
    expect(isHomeKpiSplitConfigId('b_random')).toBe(false);
  });
});

describe('homeKpiInheritedShell', () => {
  it('carries source / period / includeToday, ignoring style + title', () => {
    expect(
      homeKpiInheritedShell({ period: 90, source: 7, includeToday: false } as never),
    ).toEqual({ period: 90, source: 7, includeToday: false });
  });

  it('is empty for a shell-less old card', () => {
    expect(homeKpiInheritedShell(null)).toEqual({});
    expect(homeKpiInheritedShell({} as never)).toEqual({});
  });
});

describe('homeKpiSplitConfig / homeKpiSplitConfigs', () => {
  it('builds a validated config with the deterministic id, spec viz + size, and inherited shell', () => {
    const cfg = homeKpiSplitConfig({ metricId: 'tg.views', viz: 'line', size: 'half' }, { period: 7, source: 4 });
    expect(cfg.id).toBe('home-kpi-tg-views');
    expect(cfg.metricId).toBe('tg.views');
    expect(cfg.viz).toBe('line');
    expect(cfg.size).toBe('half');
    expect(cfg.period).toBe(7);
    expect(cfg.source).toBe(4);
    // Style / title are intentionally not inherited.
    expect(cfg.style).toBeUndefined();
    expect(cfg.title).toBeUndefined();
  });

  it('coerces a bad inherited value away (re-validated through the normalizer)', () => {
    const cfg = homeKpiSplitConfig({ metricId: 'tg.avgReach', viz: 'bar', size: 'third' }, { source: 0, period: 45 as never });
    expect(cfg.source).toBeUndefined(); // 0 is not a real channel
    expect(cfg.period).toBeUndefined(); // 45 is not a preset
    expect(cfg.viz).toBe('bar');
    expect(cfg.size).toBe('third');
  });

  it('the ER card is a kpi value tile', () => {
    const cfg = homeKpiSplitConfig({ metricId: 'tg.er', viz: 'kpi', size: 'third' }, {});
    expect(cfg.viz).toBe('kpi');
    expect(cfg.size).toBe('third');
  });

  it('produces all five configs in order for an empty shell', () => {
    const all = homeKpiSplitConfigs();
    expect(all.map((c) => c.id)).toEqual([
      'home-kpi-tg-views',
      'home-kpi-tg-subscribers',
      'home-kpi-tg-avgReach',
      'home-kpi-tg-reactions',
      'home-kpi-tg-er',
    ]);
    expect(all.map((c) => c.size)).toEqual(['half', 'half', 'third', 'third', 'third']);
  });
});

describe('homeKpiSplitTargets (duplicate avoidance)', () => {
  it('returns all five when nothing is already pinned', () => {
    expect(homeKpiSplitTargets(new Set()).map((s) => s.metricId)).toEqual(HOME_KPI_SPLIT_METRIC_IDS);
  });

  it('skips a metric already represented on the board', () => {
    expect(homeKpiSplitTargets(new Set(['tg.views', 'tg.er'])).map((s) => s.metricId)).toEqual([
      'tg.subscribers',
      'tg.avgReach',
      'tg.reactions',
    ]);
  });
});

describe('splitKpiInHomeKeys', () => {
  it('replaces the kpi token in place with the five split keys, preserving order', () => {
    const next = splitKpiInHomeKeys(['week', 'kpi', 'growth', 'top-posts'], new Set());
    expect(next).toEqual([
      'week',
      customKey('home-kpi-tg-views'),
      customKey('home-kpi-tg-subscribers'),
      customKey('home-kpi-tg-avgReach'),
      customKey('home-kpi-tg-reactions'),
      customKey('home-kpi-tg-er'),
      'growth',
      'top-posts',
    ]);
  });

  it('is a no-op (null) when there is no kpi token — idempotent / repeat-safe', () => {
    expect(splitKpiInHomeKeys(['week', 'growth'], new Set())).toBeNull();
    // A board already split has no kpi token → re-running is a no-op.
    const once = splitKpiInHomeKeys(['kpi'], new Set())!;
    expect(splitKpiInHomeKeys(once, new Set())).toBeNull();
  });

  it('skips split keys already pinned and metrics already represented (no duplicates)', () => {
    // tg.views already pinned as its own split key; tg.er already pinned as a separate custom card.
    const keys = [customKey('home-kpi-tg-views'), 'kpi', 'growth'];
    const next = splitKpiInHomeKeys(keys, new Set(['tg.er']));
    expect(next).toEqual([
      customKey('home-kpi-tg-views'), // kept, not duplicated
      customKey('home-kpi-tg-subscribers'),
      customKey('home-kpi-tg-avgReach'),
      customKey('home-kpi-tg-reactions'),
      // tg.er skipped (already pinned separately); tg.views not re-inserted
      'growth',
    ]);
  });

  it('recognises and replaces the config-backed legacy representation too', () => {
    expect(isLegacyKpiHomeKey(customKey('legacy-kpi'))).toBe(true);
    expect(splitKpiInHomeKeys(['week', customKey('legacy-kpi'), 'growth'], new Set())).toEqual([
      'week',
      customKey('home-kpi-tg-views'),
      customKey('home-kpi-tg-subscribers'),
      customKey('home-kpi-tg-avgReach'),
      customKey('home-kpi-tg-reactions'),
      customKey('home-kpi-tg-er'),
      'growth',
    ]);
  });

  it('drops duplicate legacy representations defensively', () => {
    expect(splitKpiInHomeKeys(['kpi', 'week', customKey('legacy-kpi')], new Set())).toEqual([
      customKey('home-kpi-tg-views'),
      customKey('home-kpi-tg-subscribers'),
      customKey('home-kpi-tg-avgReach'),
      customKey('home-kpi-tg-reactions'),
      customKey('home-kpi-tg-er'),
      'week',
    ]);
  });
});

describe('splitKpiInGroupOrder', () => {
  const tokens = HOME_KPI_SPLIT.map((s) => homeKpiSplitOrderToken(s.metricId));

  it('replaces the post-unification composite token (custom-legacy-kpi) at its slot', () => {
    const order = ['custom-legacy-velocity', 'custom-legacy-kpi', 'custom-legacy-growth'];
    expect(splitKpiInGroupOrder(order, tokens)).toEqual([
      'custom-legacy-velocity',
      ...tokens,
      'custom-legacy-growth',
    ]);
  });

  it('replaces the pre-unification composite token (home-kpi) at its slot', () => {
    const order = ['home-velocity', 'home-kpi', 'home-growth'];
    expect(splitKpiInGroupOrder(order, tokens)).toEqual(['home-velocity', ...tokens, 'home-growth']);
  });

  it('is a no-op (null) when no known KPI token is present', () => {
    expect(splitKpiInGroupOrder(['home-week', 'home-growth'], tokens)).toBeNull();
    expect(splitKpiInGroupOrder([], tokens)).toBeNull();
  });

  it('does not duplicate a split token already in the order', () => {
    const order = ['custom-home-kpi-tg-views', 'custom-legacy-kpi'];
    expect(splitKpiInGroupOrder(order, tokens)).toEqual([
      'custom-home-kpi-tg-views',
      // the remaining four (views already present is not re-inserted)
      'custom-home-kpi-tg-subscribers',
      'custom-home-kpi-tg-avgReach',
      'custom-home-kpi-tg-reactions',
      'custom-home-kpi-tg-er',
    ]);
  });
});
