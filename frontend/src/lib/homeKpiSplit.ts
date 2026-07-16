// Splitting the legacy Home «Показатели» composite (legacy:kpi) into five independent metric
// WidgetConfigs — the desktop Home mirror of the already-split Обзор (Overview.tsx). PURE data +
// pure migration helpers (no React, no storage, no fetching), so the reconcile logic is unit-testable
// in isolation exactly like widgetConfig's normalizer.
//
// A pinned legacy KPI card is one composite full-width block; here it becomes five source-honest
// cards on the 6-col grid — two M (half) primary signals and three S (third) compact comparisons —
// each an ordinary catalogue-metric WidgetConfig rendered through the universal ConfigWidget/resolver
// (no KPI formula is duplicated: tg.views / tg.subscribers / tg.avgReach / tg.reactions / tg.er are
// the same metrics the Overview cards and the metric pages already resolve).
//
// The config ids are DETERMINISTIC (derived from the metric id, like legacyConfigId) so the migration
// is idempotent and repeat-safe across local + account hydration: re-running it never duplicates a
// card, never resets a user's edits, and never causes a save loop — a board that is already split has
// no `kpi` token left, so every reconcile below short-circuits to a no-op.

import type { PeriodDays } from '@/lib/period';
import type { WidgetSize } from '@/lib/widgetPrefsStore';
import type { WidgetViz } from '@/lib/widgetMetrics';
import { customKey, normalizeWidget, type WidgetConfig } from '@/lib/widgetConfig';

/** The bare Home registry key of the retired Telegram composite. */
export const LEGACY_KPI_KEY = 'kpi';

/** Home has used both a bare registry key and, briefly, a config-backed key for the same
 * composite. Accept both so an older account snapshot cannot escape the migration. */
export const LEGACY_KPI_HOME_KEYS: readonly string[] = [LEGACY_KPI_KEY, customKey('legacy-kpi')];

export const isLegacyKpiHomeKey = (key: string): boolean => LEGACY_KPI_HOME_KEYS.includes(key);

/** Deterministic-config-id namespace for a split card. Distinct from the `legacy-` composite prefix
 *  and the random `genId` space, so a split card always maps to the same stored config + reorder slot
 *  across renders and devices. */
export const HOME_KPI_SPLIT_PREFIX = 'home-kpi-';

/** One split card: which catalogue metric it shows, the visualisation and its S/M footprint.
 *  `viz` is chosen so the card reads at its size AND survives the width policy (widgetSurface):
 *  a temporal LINE is coerced up from `third`, so the two S series cards use `bar` (allowed at third),
 *  the M primaries keep their default line, and the pure-value ER card is a kpi tile. */
export interface HomeKpiSplitSpec {
  metricId: string;
  viz: WidgetViz;
  size: WidgetSize;
}

/** The five cards, in the order they replace the composite (row 1: two M primaries; row 2: three S
 *  comparisons) — mirroring the Overview split (views · subscribers/growth · avg reach · reactions ·
 *  engagement). */
export const HOME_KPI_SPLIT: readonly HomeKpiSplitSpec[] = [
  { metricId: 'tg.views', viz: 'line', size: 'half' }, // M
  { metricId: 'tg.subscribers', viz: 'line', size: 'half' }, // M
  { metricId: 'tg.avgReach', viz: 'bar', size: 'third' }, // S
  { metricId: 'tg.reactions', viz: 'bar', size: 'third' }, // S
  { metricId: 'tg.er', viz: 'kpi', size: 'third' }, // S (value metric → kpi tile)
] as const;

/** The metric ids the split materialises — the set a Home board must not double up on. */
export const HOME_KPI_SPLIT_METRIC_IDS: readonly string[] = HOME_KPI_SPLIT.map((s) => s.metricId);

/** Deterministic config id for a split card (`tg.views` → `home-kpi-tg-views`). Dots become hyphens
 *  so the derived ChartSection dom id (`custom-<id>`) stays a clean selector. */
export const homeKpiSplitConfigId = (metricId: string): string =>
  `${HOME_KPI_SPLIT_PREFIX}${metricId.replace(/\./g, '-')}`;

/** Is this config id one of the split cards' deterministic ids? */
export const isHomeKpiSplitConfigId = (id: string): boolean => id.startsWith(HOME_KPI_SPLIT_PREFIX);

/** The Home pin key (`custom:<id>`) for a split card. */
export const homeKpiSplitCustomKey = (metricId: string): string => customKey(homeKpiSplitConfigId(metricId));

/** The WidgetGroup reorder token (`custom-<id>`, the ConfigWidget ChartSection id) for a split card. */
export const homeKpiSplitOrderToken = (metricId: string): string => `custom-${homeKpiSplitConfigId(metricId)}`;

/** Reorder tokens of the OLD composite card, in every persisted representation main supports: the
 *  post-unification deterministic legacy config (`custom-legacy-kpi`) and the pre-unification
 *  per-card prefs id (`home-kpi`). */
export const LEGACY_KPI_ORDER_TOKENS: readonly string[] = ['custom-legacy-kpi', 'home-kpi'];

/** Shell preferences carried over from the old composite KPI card onto each split card, where they
 *  stay meaningful per-metric. Style (one accent across five distinct metrics collapses their
 *  identity) and the «Показатели» title (not a per-metric name) are intentionally NOT propagated. */
export interface HomeKpiInheritedShell {
  period?: PeriodDays;
  source?: number;
  includeToday?: boolean;
}

/** Read the inheritable shell from the old composite config (its stored `legacy-kpi` form or a config
 *  healed from the old `home-<key>` prefs — both share the WidgetConfig shape). */
export function homeKpiInheritedShell(
  old?: Pick<WidgetConfig, 'period' | 'source' | 'includeToday'> | null,
): HomeKpiInheritedShell {
  const shell: HomeKpiInheritedShell = {};
  if (old?.period !== undefined) shell.period = old.period;
  if (old?.source !== undefined) shell.source = old.source;
  if (old?.includeToday !== undefined) shell.includeToday = old.includeToday;
  return shell;
}

/** Build one split card's WidgetConfig, seeded with the inherited shell and re-validated through the
 *  store normalizer so a stale inherited value can never yield an invalid config. */
export function homeKpiSplitConfig(spec: HomeKpiSplitSpec, shell: HomeKpiInheritedShell): WidgetConfig {
  const base: WidgetConfig = {
    id: homeKpiSplitConfigId(spec.metricId),
    metricId: spec.metricId,
    // The spec viz when the metric supports it; normalizeWidget coerces to the metric default if not.
    viz: spec.viz,
    size: spec.size,
  };
  if (shell.period !== undefined) base.period = shell.period;
  if (shell.source !== undefined) base.source = shell.source;
  if (shell.includeToday !== undefined) base.includeToday = shell.includeToday;
  return normalizeWidget(base) ?? base;
}

/** The full ordered set of five split configs for a given inherited shell. */
export function homeKpiSplitConfigs(shell: HomeKpiInheritedShell = {}): WidgetConfig[] {
  return HOME_KPI_SPLIT.map((spec) => homeKpiSplitConfig(spec, shell));
}

/** Which split cards to materialise: those whose metric isn't already represented on the board by
 *  another pinned card (duplicate avoidance). */
export function homeKpiSplitTargets(alreadyPinnedMetricIds: ReadonlySet<string>): HomeKpiSplitSpec[] {
  return HOME_KPI_SPLIT.filter((spec) => !alreadyPinnedMetricIds.has(spec.metricId));
}

/**
 * Replace the first `kpi` token in a Home pin-key list with the split cards' `custom:<id>` keys,
 * inserted AT the composite's slot so the board order and every other widget are untouched. Targets
 * already represented (`alreadyPinnedMetricIds`) and split keys already pinned are skipped so a repeat
 * run never duplicates. Returns null when there is no `kpi` token — the idempotent no-op that makes
 * the migration safe to run on every hydrate.
 */
export function splitKpiInHomeKeys(keys: string[], alreadyPinnedMetricIds: ReadonlySet<string>): string[] | null {
  const at = keys.findIndex(isLegacyKpiHomeKey);
  if (at < 0) return null;
  const insert = homeKpiSplitTargets(alreadyPinnedMetricIds)
    .map((spec) => homeKpiSplitCustomKey(spec.metricId))
    .filter((key) => !keys.includes(key));
  const next = [...keys.slice(0, at), ...insert, ...keys.slice(at + 1)];
  // Defensive: a board should never carry two `kpi` tokens, but drop any stray extra too.
  return next.filter((key) => !isLegacyKpiHomeKey(key));
}

/**
 * Replace the old composite's reorder token in a WidgetGroup order list with the split cards' order
 * tokens at the same slot (so the split lands exactly where the composite sat). Returns null when no
 * known KPI token is present (nothing to reorder — the split cards then flow in mount/pin order).
 */
export function splitKpiInGroupOrder(order: string[], tokens: string[]): string[] | null {
  const at = order.findIndex((token) => LEGACY_KPI_ORDER_TOKENS.includes(token));
  if (at < 0) return null;
  const insert = tokens.filter((token) => !order.includes(token));
  const next = [...order.slice(0, at), ...insert, ...order.slice(at + 1)];
  return next.filter((token) => !LEGACY_KPI_ORDER_TOKENS.includes(token));
}
