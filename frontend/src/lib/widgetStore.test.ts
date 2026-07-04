import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWidgetStoreCache,
  addWidgetConfig,
  addWidgetForMetric,
  getWidgetConfig,
  getWidgetConfigs,
  reconcileHydratedConfigs,
  removeWidgetConfig,
  setWidgetConfigs,
  syncableWidgetConfigs,
  updateWidgetConfig,
} from '@/lib/widgetStore';

// vitest runs in node — provide an in-memory localStorage so the store's reads/writes work.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

beforeAll(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
});

beforeEach(() => {
  localStorage.clear();
  __resetWidgetStoreCache();
});

describe('widgetStore', () => {
  it('starts empty', () => {
    expect(getWidgetConfigs()).toEqual([]);
  });

  it('adds a fresh widget for a metric and reads it back', () => {
    const w = addWidgetForMetric('tg.views');
    expect(w).not.toBeNull();
    expect(w!.metricId).toBe('tg.views');
    expect(w!.viz).toBe('line');
    const all = getWidgetConfigs();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(w!.id);
    expect(getWidgetConfig(w!.id)).toEqual(w);
  });

  it('rejects an unknown metric without mutating the store', () => {
    expect(addWidgetForMetric('nope.metric')).toBeNull();
    expect(addWidgetConfig({ metricId: 'nope.metric', viz: 'line' })).toBeNull();
    expect(getWidgetConfigs()).toEqual([]);
  });

  it('reassigns a colliding id on add', () => {
    const a = addWidgetConfig({ id: 'dup', metricId: 'tg.views' })!;
    const b = addWidgetConfig({ id: 'dup', metricId: 'tg.reactions' })!;
    expect(a.id).toBe('dup');
    expect(b.id).not.toBe('dup');
    expect(getWidgetConfigs()).toHaveLength(2);
  });

  it('updates a widget by id, preserving the id', () => {
    const w = addWidgetForMetric('tg.views')!;
    updateWidgetConfig(w.id, { viz: 'bar', title: 'Мои просмотры' });
    const updated = getWidgetConfig(w.id)!;
    expect(updated.id).toBe(w.id);
    expect(updated.viz).toBe('bar');
    expect(updated.title).toBe('Мои просмотры');
  });

  it('is a no-op when updating an unknown id', () => {
    const w = addWidgetForMetric('tg.views')!;
    updateWidgetConfig('ghost', { viz: 'bar' });
    expect(getWidgetConfig(w.id)!.viz).toBe('line');
    expect(getWidgetConfigs()).toHaveLength(1);
  });

  it('removes a widget by id', () => {
    const w = addWidgetForMetric('tg.views')!;
    removeWidgetConfig(w.id);
    expect(getWidgetConfigs()).toEqual([]);
  });

  it('setWidgetConfigs replaces and validates (drops invalid)', () => {
    setWidgetConfigs([
      { metricId: 'tg.views', viz: 'line' },
      { metricId: 'ghost.metric', viz: 'line' },
      'nope',
    ]);
    expect(getWidgetConfigs().map((c) => c.metricId)).toEqual(['tg.views']);
  });

  it('recovers from a corrupt localStorage blob', () => {
    localStorage.setItem('pulse_widget_configs', 'not json{');
    __resetWidgetStoreCache();
    expect(getWidgetConfigs()).toEqual([]);
  });

  it('returns a stable snapshot reference until a mutation (useSyncExternalStore safety)', () => {
    addWidgetForMetric('tg.views');
    const a = getWidgetConfigs();
    const b = getWidgetConfigs();
    expect(a).toBe(b); // same reference → no render loop
    addWidgetForMetric('tg.reactions');
    const c = getWidgetConfigs();
    expect(c).not.toBe(a); // changed after mutation
    expect(c).toHaveLength(2);
  });
});

const LEGACY_KPI = { id: 'legacy-kpi', metricId: 'legacy:kpi', viz: 'kpi' as const };

describe('account-sync reconciliation', () => {
  it('syncableWidgetConfigs excludes legacy composites (they are re-derived per device)', () => {
    setWidgetConfigs([{ id: 'w1', metricId: 'tg.views', viz: 'line' }, LEGACY_KPI]);
    expect(getWidgetConfigs()).toHaveLength(2);
    expect(syncableWidgetConfigs().map((c) => c.id)).toEqual(['w1']);
  });

  it('account configs win on hydrate; a config present at mount does not override the account', () => {
    setWidgetConfigs([{ id: 'local1', metricId: 'tg.views', viz: 'line' }]);
    const baseline = new Set(['local1']); // local1 existed at mount → not a raced create
    const { seed, pushBack } = reconcileHydratedConfigs([{ id: 'acc1', metricId: 'tg.reactions', viz: 'line' }], baseline);
    expect(seed.map((c) => c.id)).toEqual(['acc1']); // account wins, local1 dropped
    expect(pushBack).toBe(false);
  });

  it('preserves device-local legacy configs across an account-wins hydrate', () => {
    setWidgetConfigs([{ id: 'local1', metricId: 'tg.views', viz: 'line' }, LEGACY_KPI]);
    const { seed } = reconcileHydratedConfigs([{ id: 'acc1', metricId: 'tg.reactions', viz: 'line' }], new Set(['local1']));
    expect(seed.map((c) => c.id).sort()).toEqual(['acc1', 'legacy-kpi']); // legacy kept, non-legacy local dropped
  });

  it('an empty account array wins (wipes local builder configs) but keeps legacy', () => {
    setWidgetConfigs([{ id: 'local1', metricId: 'tg.views', viz: 'line' }, LEGACY_KPI]);
    const { seed, pushBack } = reconcileHydratedConfigs([], new Set(['local1']));
    expect(seed.map((c) => c.id)).toEqual(['legacy-kpi']);
    expect(pushBack).toBe(false);
  });

  it('unions a widget CREATED in the GET window (absent from the mount baseline) so it is not lost', () => {
    setWidgetConfigs([
      { id: 'acc1', metricId: 'tg.views', viz: 'line' },
      { id: 'raced', metricId: 'tg.reactions', viz: 'line' },
    ]);
    // The mount baseline snapshot did NOT include 'raced' — it was created after mount, mid-GET.
    const { seed, pushBack } = reconcileHydratedConfigs([{ id: 'acc1', metricId: 'tg.views', viz: 'line' }], new Set(['acc1']));
    expect(seed.map((c) => c.id).sort()).toEqual(['acc1', 'raced']); // raced widget preserved
    expect(pushBack).toBe(true); // account must be told
  });

  it('does NOT resurrect a stale pre-existing widget deleted on another device (in baseline, not raced)', () => {
    setWidgetConfigs([{ id: 'stale-local', metricId: 'tg.views', viz: 'line' }]);
    // stale-local was present at mount (in baseline) and the account no longer has it → account wins.
    const { seed, pushBack } = reconcileHydratedConfigs([{ id: 'acc1', metricId: 'tg.reactions', viz: 'line' }], new Set(['stale-local']));
    expect(seed.map((c) => c.id)).toEqual(['acc1']); // stale local does NOT override the account
    expect(pushBack).toBe(false);
  });
});
