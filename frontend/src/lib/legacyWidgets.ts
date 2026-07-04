// Pure legacy-widget registry data (no React) — the keys, labels, editing capabilities and the
// `legacy:<key>` metricId namespace that let the composite legacy cards (Показатели / Инсайт / Топ
// постов / …) live as first-class WidgetConfigs alongside metric widgets. The React render functions
// live in components/legacyAdapters.tsx; this half stays pure so widgetConfig's normalizer can
// validate legacy configs without pulling in the UI.
//
// A legacy widget is a WidgetConfig whose metricId is `legacy:<key>` — the resolver/renderer route
// that to the adapter instead of a catalogue metric. Composite blocks aren't single metrics, so they
// declare which builder controls apply (capabilities); everything they can't drive is hidden, but the
// shell (period / source / title / size / style) is always editable — one system, one editor.

import type { WidgetSize } from '@/components/ChartWidget';

/** Which builder controls a widget can drive. Metric widgets derive these from their MetricDef;
 *  legacy widgets declare them here. Period / source / title / size / style are universal shell and
 *  not gated by capabilities. */
export interface WidgetCapabilities {
  /** Can the underlying metric be swapped? (catalogue metrics: no by design; here: never). */
  metric: boolean;
  /** Visualisation switch (line/bar/…). */
  viz: boolean;
  /** Grain (day…year). */
  grain: boolean;
  /** Comparison baseline + ghost. */
  comparison: boolean;
  /** Goal line / target. */
  target: boolean;
  /** Per-post filters. */
  filter: boolean;
}

export const LEGACY_KEYS = ['kpi', 'digest', 'growth', 'top-posts', 'history', 'velocity', 'heatmap', 'mentions'] as const;
export type LegacyKey = (typeof LEGACY_KEYS)[number];

export const LEGACY_LABEL: Record<LegacyKey, string> = {
  kpi: 'Показатели',
  digest: 'Инсайт',
  growth: 'Рост подписчиков',
  'top-posts': 'Топ постов',
  history: 'История подписчиков',
  velocity: 'Скорость набора просмотров',
  heatmap: 'Тепловая карта активности',
  mentions: 'Упоминания по дням',
};

/** The footprint a legacy widget wants when the user hasn't chosen one (mirrors the old registry). */
export const LEGACY_DEFAULT_SIZE: Partial<Record<LegacyKey, WidgetSize>> = {
  kpi: 'full',
  'top-posts': 'full',
  heatmap: 'full',
};

// Composite blocks are fixed compositions, not single metrics — none of the metric-level controls
// apply, so they edit shell-only (period / source / title / size / style). Richer per-legacy
// capabilities (e.g. a comparison toggle on «Показатели») can be turned on here later as the blocks
// learn to consume them.
const SHELL_ONLY: WidgetCapabilities = { metric: false, viz: false, grain: false, comparison: false, target: false, filter: false };

export const LEGACY_CAPABILITIES: Record<LegacyKey, WidgetCapabilities> = {
  kpi: SHELL_ONLY,
  digest: SHELL_ONLY,
  growth: SHELL_ONLY,
  'top-posts': SHELL_ONLY,
  history: SHELL_ONLY,
  velocity: SHELL_ONLY,
  heatmap: SHELL_ONLY,
  mentions: SHELL_ONLY,
};

// ── `legacy:<key>` metricId namespace ─────────────────────────────────────────────────────────
export const LEGACY_PREFIX = 'legacy:';
export const legacyMetricId = (key: string): string => `${LEGACY_PREFIX}${key}`;
export const isLegacyMetricId = (id: string): boolean => id.startsWith(LEGACY_PREFIX);
export const legacyKeyOf = (id: string): string => (isLegacyMetricId(id) ? id.slice(LEGACY_PREFIX.length) : id);
export function isLegacyKey(key: string): key is LegacyKey {
  return (LEGACY_KEYS as readonly string[]).includes(key);
}
/** The legacy key backing a config's metricId, or null if it isn't a (known) legacy widget. */
export function legacyKeyForMetricId(metricId: string): LegacyKey | null {
  if (!isLegacyMetricId(metricId)) return null;
  const key = legacyKeyOf(metricId);
  return isLegacyKey(key) ? key : null;
}
