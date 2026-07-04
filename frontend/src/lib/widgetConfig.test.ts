import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PREFIX,
  configIdFromKey,
  customKey,
  defaultWidget,
  healedLegacyConfig,
  isCustomKey,
  legacyConfigSeed,
  legacyHomeConfig,
  legacyWidgetConfig,
  normalizeWidget,
  normalizeWidgets,
  type WidgetConfig,
} from '@/lib/widgetConfig';
import { legacyConfigId, legacyKeyFromConfigId } from '@/lib/legacyWidgets';

describe('defaultWidget', () => {
  it('creates a config with the metric default viz', () => {
    const w = defaultWidget('tg.views');
    expect(w).not.toBeNull();
    expect(w!.metricId).toBe('tg.views');
    expect(w!.viz).toBe('line'); // tg.views defaultViz
    expect(w!.id).toBeTruthy();
  });

  it('returns null for an unknown metric', () => {
    expect(defaultWidget('nope.metric')).toBeNull();
    expect(defaultWidget('')).toBeNull();
  });
});

describe('normalizeWidgets', () => {
  it('returns [] for non-array input, never throwing', () => {
    expect(normalizeWidgets(undefined)).toEqual([]);
    expect(normalizeWidgets(null)).toEqual([]);
    expect(normalizeWidgets('x')).toEqual([]);
    expect(normalizeWidgets(42)).toEqual([]);
    expect(normalizeWidgets({})).toEqual([]);
  });

  it('drops elements with unknown / missing metricId', () => {
    const out = normalizeWidgets([
      { metricId: 'tg.views', viz: 'line' },
      { metricId: 'ghost.metric', viz: 'line' },
      { viz: 'line' },
      null,
      7,
      'nope',
      [],
    ]);
    expect(out.map((w) => w.metricId)).toEqual(['tg.views']);
  });

  it('makes duplicate ids unique', () => {
    const out = normalizeWidgets([
      { id: 'dup', metricId: 'tg.views' },
      { id: 'dup', metricId: 'tg.reactions' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('dup');
    expect(out[1].id).not.toBe('dup');
  });
});

describe('legacy widgets (U6) — `legacy:<key>` configs', () => {
  it('legacyWidgetConfig builds a config with the legacy metricId + default size', () => {
    const w = legacyWidgetConfig('kpi');
    expect(w).not.toBeNull();
    expect(w!.metricId).toBe('legacy:kpi');
    expect(w!.viz).toBe('kpi');
    expect(w!.size).toBe('full'); // kpi default size
    expect(legacyWidgetConfig('nope')).toBeNull();
  });

  it('normalizeWidget keeps a known legacy config + its shell fields, drops an unknown legacy key', () => {
    const w = normalizeWidget({ metricId: 'legacy:digest', viz: 'x', title: 'Мой инсайт', period: 90, size: 'half', source: 4, style: { color: 2 } })!;
    expect(w.metricId).toBe('legacy:digest');
    expect(w.viz).toBe('kpi'); // legacy sentinel (no catalogue viz)
    expect(w.title).toBe('Мой инсайт');
    expect(w.period).toBe(90);
    expect(w.size).toBe('half');
    expect(w.source).toBe(4);
    expect(w.style).toEqual({ color: 2 });
    expect(normalizeWidget({ metricId: 'legacy:ghost' })).toBeNull(); // unknown legacy key
  });

  it('normalizeWidgets mixes metric + legacy configs in one list', () => {
    const out = normalizeWidgets([
      { metricId: 'tg.views', viz: 'line' },
      { metricId: 'legacy:kpi' },
      { metricId: 'legacy:bad' },
      { metricId: 'ghost.metric' },
    ]);
    expect(out.map((w) => w.metricId)).toEqual(['tg.views', 'legacy:kpi']);
  });

  it('legacyHomeConfig uses a stable id derived from the key (Home pin/heal)', () => {
    const a = legacyHomeConfig('kpi');
    const b = legacyHomeConfig('kpi');
    expect(a).not.toBeNull();
    expect(a!.id).toBe(legacyConfigId('kpi'));
    // Deterministic: two calls agree byte-for-byte (no random genId), so a re-derived / healed
    // config maps to the same stored entry across renders and devices.
    expect(a).toEqual(b);
    expect(a!.metricId).toBe('legacy:kpi');
    expect(a!.size).toBe('full'); // kpi default size carried through
    expect(legacyKeyFromConfigId(a!.id)).toBe('kpi'); // round-trips id → key
    expect(legacyHomeConfig('nope')).toBeNull();
  });

  it('legacyHomeConfig survives store normalisation with its id + shell intact', () => {
    const a = legacyHomeConfig('digest')!;
    const stored = normalizeWidget({ ...a, period: 90, title: 'Мой инсайт' })!;
    expect(stored.id).toBe(legacyConfigId('digest'));
    expect(stored.metricId).toBe('legacy:digest');
    expect(stored.period).toBe(90);
    expect(stored.title).toBe('Мой инсайт');
  });

  it('legacyKeyFromConfigId only accepts a `legacy-<known>` config id', () => {
    expect(legacyKeyFromConfigId('legacy-top-posts')).toBe('top-posts');
    expect(legacyKeyFromConfigId('legacy-heatmap')).toBe('heatmap');
    expect(legacyKeyFromConfigId('legacy-nope')).toBeNull();
    expect(legacyKeyFromConfigId('legacy:kpi')).toBeNull(); // metricId form, not a config id
    expect(legacyKeyFromConfigId('b_random')).toBeNull();
  });

  it('legacyConfigSeed maps old home-<key> prefs into a config patch (period/size/title/source/style)', () => {
    expect(legacyConfigSeed({ period: 90, size: 'third', title: 'Мой KPI', source: 4, color: 2, tinted: true })).toEqual({
      period: 90,
      size: 'third',
      title: 'Мой KPI',
      source: 4,
      style: { color: 2, tinted: true },
    });
    // Empty / default prefs → empty patch (nothing to carry). `hidden` is NOT a config field.
    expect(legacyConfigSeed({})).toEqual({});
    // A 0 / negative source is not a real channel → dropped; a lone accent still yields a style.
    expect(legacyConfigSeed({ source: 0 })).toEqual({});
    expect(legacyConfigSeed({ color: 5 })).toEqual({ style: { color: 5 } });
  });

  it('healedLegacyConfig seeds the deterministic legacy config with migrated prefs, re-validated', () => {
    const w = healedLegacyConfig('kpi', { period: 7, source: 4, color: 3 })!;
    expect(w.id).toBe(legacyConfigId('kpi')); // stable id preserved
    expect(w.metricId).toBe('legacy:kpi');
    expect(w.viz).toBe('kpi'); // legacy sentinel survives normalisation
    expect(w.period).toBe(7);
    expect(w.source).toBe(4);
    expect(w.style).toEqual({ color: 3 });
    expect(w.size).toBe('full'); // legacy default kept when prefs carry no size
    // No prefs → the plain deterministic config (equivalent to legacyHomeConfig).
    expect(healedLegacyConfig('digest', {})).toEqual(legacyHomeConfig('digest'));
    // A garbage prefs period can't produce an invalid config (normalizeWidget drops it).
    expect(healedLegacyConfig('kpi', { period: 999 as unknown as 7 })!.period).toBeUndefined();
    expect(healedLegacyConfig('nope', { period: 7 })).toBeNull();
  });
});

describe('normalizeWidget — viz coercion', () => {
  it('keeps a supported viz', () => {
    expect(normalizeWidget({ metricId: 'tg.views', viz: 'bar' })!.viz).toBe('bar');
    expect(normalizeWidget({ metricId: 'tg.views', viz: 'line' })!.viz).toBe('line');
  });

  it('coerces an unsupported viz to the metric default', () => {
    // rank/pivot are no longer offered (not rendered from a WidgetResult) → fall back to line.
    expect(normalizeWidget({ metricId: 'tg.views', viz: 'rank' })!.viz).toBe('line');
    // tg.er is a value metric → supportedViz [kpi]; a line request falls back to kpi.
    expect(normalizeWidget({ metricId: 'tg.er', viz: 'line' })!.viz).toBe('kpi');
    // garbage viz → default
    expect(normalizeWidget({ metricId: 'tg.views', viz: 'squiggle' })!.viz).toBe('line');
    expect(normalizeWidget({ metricId: 'tg.views' })!.viz).toBe('line');
  });
});

describe('normalizeWidget — optional field validation', () => {
  it('validates period / grain / size / source / includeToday / title', () => {
    const w = normalizeWidget({
      metricId: 'tg.views',
      title: 'Мои просмотры',
      period: 90,
      grain: 'quarter',
      size: 'full',
      source: 4,
      includeToday: false,
    })!;
    expect(w.title).toBe('Мои просмотры');
    expect(w.period).toBe(90);
    expect(w.grain).toBe('quarter');
    expect(w.size).toBe('full');
    expect(w.source).toBe(4);
    expect(w.includeToday).toBe(false);
  });

  it('drops malformed optional fields', () => {
    const w = normalizeWidget({
      metricId: 'tg.views',
      title: '',
      period: 45, // not a preset
      grain: 'decade',
      size: 'huge',
      source: -3,
      includeToday: 'yes',
    })!;
    expect(w.title).toBeUndefined();
    expect(w.period).toBeUndefined();
    expect(w.grain).toBeUndefined();
    expect(w.size).toBeUndefined();
    expect(w.source).toBeUndefined();
    expect(w.includeToday).toBeUndefined();
  });

  it('rounds a fractional source channel id and rejects zero', () => {
    expect(normalizeWidget({ metricId: 'tg.views', source: 4.9 })!.source).toBe(5);
    expect(normalizeWidget({ metricId: 'tg.views', source: 0 })!.source).toBeUndefined();
    expect(normalizeWidget({ metricId: 'tg.views', source: 0.4 })!.source).toBeUndefined(); // rounds to 0 → rejected
  });
});

describe('normalizeWidget — filters (S7)', () => {
  it('keeps a well-formed filter and drops the rest', () => {
    const w = normalizeWidget({
      metricId: 'tg.views',
      filters: [
        { dimensionId: 'tg.format', op: 'in', values: ['Фото', 'Видео'] },
        { dimensionId: 'tg.format', op: 'bad', values: ['x'] }, // bad op
        { dimensionId: '', op: 'eq', values: ['x'] }, // no dimension
        { dimensionId: 'tg.format', op: 'eq', values: [] }, // empty values → inert
        { dimensionId: 'tg.format', op: 'eq' }, // no values array
        'nope',
      ],
    })!;
    expect(w.filters).toHaveLength(1);
    expect(w.filters![0]).toEqual({ dimensionId: 'tg.format', op: 'in', values: ['Фото', 'Видео'] });
  });

  it('omits filters entirely when none are valid', () => {
    expect(normalizeWidget({ metricId: 'tg.views', filters: [{ bad: 1 }] })!.filters).toBeUndefined();
    expect(normalizeWidget({ metricId: 'tg.views', filters: 'x' })!.filters).toBeUndefined();
  });
});

describe('normalizeWidget — comparison (S8)', () => {
  it('keeps a valid comparison and coerces display', () => {
    const w = normalizeWidget({
      metricId: 'tg.views',
      comparison: { mode: 'previous_period', display: 'ghost_line' },
    })!;
    expect(w.comparison).toEqual({ mode: 'previous_period', display: 'ghost_line' });
  });

  it('drops an invalid mode and a bad display', () => {
    expect(normalizeWidget({ metricId: 'tg.views', comparison: { mode: 'yesterday' } })!.comparison).toBeUndefined();
    const w = normalizeWidget({ metricId: 'tg.views', comparison: { mode: 'custom', display: 'sparkle', from: 1, to: 2 } })!;
    expect(w.comparison).toEqual({ mode: 'custom', from: 1, to: 2 });
  });
});

describe('normalizeWidget — target (S9)', () => {
  it('keeps a fixed target with a value', () => {
    expect(normalizeWidget({ metricId: 'tg.views', target: { type: 'fixed', value: 1000 } })!.target).toEqual({
      type: 'fixed',
      value: 1000,
    });
  });

  it('validates a dynamic target metricId against the catalogue', () => {
    const good = normalizeWidget({ metricId: 'tg.views', target: { type: 'dynamic', metricId: 'tg.subscribers', periodMode: 'to_date' } })!;
    expect(good.target).toEqual({ type: 'dynamic', metricId: 'tg.subscribers', periodMode: 'to_date' });
    const bad = normalizeWidget({ metricId: 'tg.views', target: { type: 'dynamic', metricId: 'ghost.metric' } })!;
    expect(bad.target).toEqual({ type: 'dynamic' });
  });

  it('drops an invalid target type', () => {
    expect(normalizeWidget({ metricId: 'tg.views', target: { type: 'wish' } })!.target).toBeUndefined();
  });
});

describe('normalizeWidget — style', () => {
  it('keeps color 1..6 and tinted', () => {
    expect(normalizeWidget({ metricId: 'tg.views', style: { color: 3, tinted: true } })!.style).toEqual({ color: 3, tinted: true });
  });
  it('drops out-of-range color and falsy tinted', () => {
    expect(normalizeWidget({ metricId: 'tg.views', style: { color: 9 } })!.style).toBeUndefined();
    expect(normalizeWidget({ metricId: 'tg.views', style: { tinted: false } })!.style).toBeUndefined();
  });
});

describe('round-trip stability', () => {
  it('normalizing a normalized list is a fixpoint (ids preserved)', () => {
    const once = normalizeWidgets([
      { metricId: 'tg.views', viz: 'bar', period: 30, grain: 'week', comparison: { mode: 'previous_period', display: 'both' }, target: { type: 'fixed', value: 500 }, style: { color: 2 } },
      { metricId: 'ig.reach', viz: 'line', filters: [{ dimensionId: 'ig.media_type', op: 'eq', values: ['REELS'] }] },
    ]);
    const twice = normalizeWidgets(once as unknown[]);
    expect(twice).toEqual(once);
  });
});

describe('custom-key helpers', () => {
  it('round-trips a config id through the custom key', () => {
    const key = customKey('abc123');
    expect(key).toBe(`${CUSTOM_PREFIX}abc123`);
    expect(isCustomKey(key)).toBe(true);
    expect(isCustomKey('digest')).toBe(false);
    expect(configIdFromKey(key)).toBe('abc123');
    expect(configIdFromKey('digest')).toBeNull();
    expect(configIdFromKey(CUSTOM_PREFIX)).toBeNull(); // empty id
  });
});

// A tiny compile-time-ish shape guard so the exported type stays usable.
describe('WidgetConfig shape', () => {
  it('defaultWidget output carries id, metricId, viz + a recommended size', () => {
    const w: WidgetConfig = defaultWidget('ig.reach')!;
    expect(Object.keys(w).sort()).toEqual(['id', 'metricId', 'size', 'viz']);
    expect(w.size).toBe('half'); // ig.reach is a line series → half
    expect(defaultWidget('tg.er')!.size).toBe('third'); // value/KPI → third
  });
});
