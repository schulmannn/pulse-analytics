// The widget-configuration model — a widget is `{ id, metricId, viz, …options }`, a small
// semantic-analytics object the user assembles (metric + visualisation + period + grain +
// comparison + target + filter + source + style). This is the steep «конструктор метрик» unit.
//
// Kept React-free and pure (like reportBlocks.ts) so `normalizeWidgets` — which decides whether a
// stored widget keeps working across versions — is unit-testable in isolation. It NEVER throws:
// unknown metrics / malformed fields are dropped or coerced to a safe default, never surfaced as a
// crash. Rendering + editing (S3 resolver, S4 renderer, S5 editor) consume this; nothing here
// touches the DOM or fetches data.
//
// The config vocabulary is intentionally the FULL steep set from day one (comparison/target/filter
// shapes for S7–S9, grain up to year for S10) so later sprints extend behaviour without reshaping
// stored data — a forward-compatible field simply round-trips until its sprint teaches the resolver
// to honour it.

import type { PeriodDays } from '@/lib/period';
import type { WidgetSize } from '@/components/ChartWidget';
import { getMetric, isMetricId, recommendedSize, type WidgetViz } from '@/lib/widgetMetrics';
import { genId } from '@/lib/reportBlocks';
import { LEGACY_DEFAULT_SIZE, isLegacyKey, legacyKeyForMetricId, legacyMetricId } from '@/lib/legacyWidgets';

/** Series bucketing — richer than the current day/week/month (S10 teaches metricSeries the rest;
 *  until then quarter/year simply round-trip, and the resolver clamps to what it can bucket). */
export type WidgetGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

// ── Comparison (S8) ──────────────────────────────────────────────────────────────────────────
export type ComparisonMode =
  | 'none'
  | 'previous_period'
  | 'same_period_last_month'
  | 'same_period_last_year'
  | 'custom';
/** How the baseline is shown: a delta pill, a ghost line/bar overlay, or both. */
export type ComparisonDisplay = 'delta' | 'ghost_line' | 'both';
export interface ComparisonConfig {
  mode: ComparisonMode;
  display?: ComparisonDisplay;
  /** For `mode:'custom'` — an explicit baseline window (epoch ms). */
  from?: number;
  to?: number;
}

// ── Target / forecast (S9) ─────────────────────────────────────────────────────────────────────
export type TargetType = 'fixed' | 'dynamic' | 'forecast';
export type TargetPeriodMode = 'full_period' | 'to_date';
export interface TargetConfig {
  type: TargetType;
  /** For `type:'fixed'` — the goal value. */
  value?: number;
  /** For `type:'dynamic'` — the metric whose value is the goal. */
  metricId?: string;
  /** Whether progress is measured against the whole period or up to today. */
  periodMode?: TargetPeriodMode;
}

// ── Filter (S7) ────────────────────────────────────────────────────────────────────────────────
export type FilterOp = 'eq' | 'in' | 'not_in' | 'contains' | 'gt' | 'lt';
export interface WidgetFilter {
  /** A dimension id from the DIMENSIONS catalogue (formalised in S7). */
  dimensionId: string;
  op: FilterOp;
  values: Array<string | number>;
}

// ── Style ────────────────────────────────────────────────────────────────────────────────────
export interface WidgetStyle {
  /** Accent — a chart token index 1..6; undefined = brand accent (mirrors WidgetPrefs.color). */
  color?: number;
  /** Tinted card background in the accent colour. */
  tinted?: boolean;
}

/** A configured widget — the metric-builder's output. `viz` is always one the metric supports. */
export interface WidgetConfig {
  id: string;
  metricId: string;
  viz: WidgetViz;
  title?: string;
  /** Preset window (0 = «Всё»); undefined = the surface default. */
  period?: PeriodDays;
  grain?: WidgetGrain;
  includeToday?: boolean;
  /** Pinned data source (a channel id); undefined = follow the switcher. */
  source?: number;
  size?: WidgetSize;
  filters?: WidgetFilter[];
  comparison?: ComparisonConfig;
  target?: TargetConfig;
  style?: WidgetStyle;
}

// ── «custom:<id>» keys — how a Home/report slot references a stored WidgetConfig alongside the
// legacy registry keys ('digest', …) and report presets. Shared convention for S4/S6 so the
// surfaces agree on how to tell a config-backed widget from a curated one. ─────────────────────
export const CUSTOM_PREFIX = 'custom:';
export const customKey = (configId: string): string => `${CUSTOM_PREFIX}${configId}`;
export const isCustomKey = (key: string): boolean => key.startsWith(CUSTOM_PREFIX);
export function configIdFromKey(key: string): string | null {
  return isCustomKey(key) ? key.slice(CUSTOM_PREFIX.length) || null : null;
}

const PERIODS = new Set<PeriodDays>([7, 30, 90, 0]);
const GRAINS = new Set<WidgetGrain>(['day', 'week', 'month', 'quarter', 'year']);
const SIZES = new Set<WidgetSize>(['third', 'half', 'full']);
const CMP_MODES = new Set<ComparisonMode>([
  'none',
  'previous_period',
  'same_period_last_month',
  'same_period_last_year',
  'custom',
]);
const CMP_DISPLAY = new Set<ComparisonDisplay>(['delta', 'ghost_line', 'both']);
const TARGET_TYPES = new Set<TargetType>(['fixed', 'dynamic', 'forecast']);
const TARGET_PERIOD = new Set<TargetPeriodMode>(['full_period', 'to_date']);
const FILTER_OPS = new Set<FilterOp>(['eq', 'in', 'not_in', 'contains', 'gt', 'lt']);

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A fresh widget for a metric — its default visualisation + recommended size. Null for unknown id. */
export function defaultWidget(metricId: string): WidgetConfig | null {
  const metric = getMetric(metricId);
  if (!metric) return null;
  return { id: genId(), metricId, viz: metric.defaultViz, size: recommendedSize(metric) };
}

/** A fresh legacy widget config (its adapter renders it). Null for an unknown legacy key. */
export function legacyWidgetConfig(key: string): WidgetConfig | null {
  if (!isLegacyKey(key)) return null;
  const size = LEGACY_DEFAULT_SIZE[key];
  return { id: genId(), metricId: legacyMetricId(key), viz: 'kpi', ...(size ? { size } : {}) };
}

function normComparison(raw: unknown): ComparisonConfig | undefined {
  if (!isObj(raw)) return undefined;
  const mode = typeof raw.mode === 'string' && CMP_MODES.has(raw.mode as ComparisonMode) ? (raw.mode as ComparisonMode) : null;
  if (!mode) return undefined;
  const cfg: ComparisonConfig = { mode };
  if (typeof raw.display === 'string' && CMP_DISPLAY.has(raw.display as ComparisonDisplay)) cfg.display = raw.display as ComparisonDisplay;
  if (isFiniteNum(raw.from)) cfg.from = raw.from;
  if (isFiniteNum(raw.to)) cfg.to = raw.to;
  return cfg;
}

function normTarget(raw: unknown): TargetConfig | undefined {
  if (!isObj(raw)) return undefined;
  const type = typeof raw.type === 'string' && TARGET_TYPES.has(raw.type as TargetType) ? (raw.type as TargetType) : null;
  if (!type) return undefined;
  const cfg: TargetConfig = { type };
  if (isFiniteNum(raw.value)) cfg.value = raw.value;
  if (isMetricId(typeof raw.metricId === 'string' ? raw.metricId : undefined)) cfg.metricId = raw.metricId as string;
  if (typeof raw.periodMode === 'string' && TARGET_PERIOD.has(raw.periodMode as TargetPeriodMode)) cfg.periodMode = raw.periodMode as TargetPeriodMode;
  return cfg;
}

function normFilter(raw: unknown): WidgetFilter | null {
  if (!isObj(raw)) return null;
  if (typeof raw.dimensionId !== 'string' || !raw.dimensionId) return null;
  if (typeof raw.op !== 'string' || !FILTER_OPS.has(raw.op as FilterOp)) return null;
  if (!Array.isArray(raw.values)) return null;
  const values = raw.values.filter((v): v is string | number => typeof v === 'string' || isFiniteNum(v));
  // A filter with no usable values is inert — drop it rather than store an empty predicate.
  if (values.length === 0) return null;
  return { dimensionId: raw.dimensionId, op: raw.op as FilterOp, values };
}

function normStyle(raw: unknown): WidgetStyle | undefined {
  if (!isObj(raw)) return undefined;
  const style: WidgetStyle = {};
  if (isFiniteNum(raw.color) && raw.color >= 1 && raw.color <= 6) style.color = Math.round(raw.color);
  if (raw.tinted === true) style.tinted = true;
  return style.color !== undefined || style.tinted !== undefined ? style : undefined;
}

/**
 * Validate/coerce one raw element into a WidgetConfig, or null if it can't be one:
 *   - not an object, or an unknown `metricId` → null (a widget without a real metric is meaningless);
 *   - `viz` coerced to one the metric supports (fallback: the metric's defaultViz);
 *   - every optional field validated against its allowed set, dropped when malformed.
 * Never throws.
 */
export function normalizeWidget(raw: unknown): WidgetConfig | null {
  if (!isObj(raw)) return null;
  const metricId = typeof raw.metricId === 'string' ? raw.metricId : '';
  // A `legacy:<key>` id is a composite legacy widget (rendered by an adapter, not the resolver); any
  // other id must be a known catalogue metric or the config is meaningless.
  const legacyKey = legacyKeyForMetricId(metricId);
  const metric = legacyKey ? null : getMetric(metricId);
  if (!legacyKey && !metric) return null;

  // Legacy widgets carry no catalogue viz — keep a stable sentinel. Metric widgets coerce to a viz
  // the metric supports (fallback: its defaultViz).
  const viz: WidgetViz = metric
    ? typeof raw.viz === 'string' && metric.supportedViz.includes(raw.viz as WidgetViz)
      ? (raw.viz as WidgetViz)
      : metric.defaultViz
    : 'kpi';

  const cfg: WidgetConfig = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : genId(),
    metricId,
    viz,
  };

  if (typeof raw.title === 'string' && raw.title) cfg.title = raw.title;
  if (isFiniteNum(raw.period) && PERIODS.has(raw.period as PeriodDays)) cfg.period = raw.period as PeriodDays;
  if (typeof raw.grain === 'string' && GRAINS.has(raw.grain as WidgetGrain)) cfg.grain = raw.grain as WidgetGrain;
  if (typeof raw.includeToday === 'boolean') cfg.includeToday = raw.includeToday;
  if (isFiniteNum(raw.source)) {
    const src = Math.round(raw.source); // round first, THEN reject non-positive (0.4 must not → 0)
    if (src > 0) cfg.source = src;
  }
  if (typeof raw.size === 'string' && SIZES.has(raw.size as WidgetSize)) cfg.size = raw.size as WidgetSize;

  if (Array.isArray(raw.filters)) {
    const filters = raw.filters.map(normFilter).filter((f): f is WidgetFilter => f !== null);
    if (filters.length) cfg.filters = filters;
  }
  const comparison = normComparison(raw.comparison);
  if (comparison) cfg.comparison = comparison;
  const target = normTarget(raw.target);
  if (target) cfg.target = target;
  const style = normStyle(raw.style);
  if (style) cfg.style = style;

  return cfg;
}

/**
 * Read a stored widget list in any shape:
 *   - missing / not an array → [] (no custom widgets);
 *   - object[]              → validated configs (unknown metric dropped, ids made unique).
 * Never throws: unusable elements are dropped.
 */
export function normalizeWidgets(raw: unknown): WidgetConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: WidgetConfig[] = [];
  const seen = new Set<string>();
  for (const el of raw) {
    const w = normalizeWidget(el);
    if (!w) continue;
    if (seen.has(w.id)) w.id = genId();
    seen.add(w.id);
    out.push(w);
  }
  return out;
}
