// Central surface + width policy for widget cards — pure, so the rule has ONE audited source and a
// unit test instead of page-by-page class exceptions (DESIGN_TOKENS.md «Surface & width policy»).
//
// Two enforceable rules, both keyed on the widget's visualisation:
//  1. Surface (colour): only a single-metric STORY card (a hero number, or its single-series line)
//     earns a tonal/accent-tinted background. Every multi-series / categorical / tabular viz stays
//     NEUTRAL regardless of the saved accent — a coloured wash behind many series or rows reads as
//     status, not story. The accent still lives on the series stroke and the hero number; only the
//     card BACKGROUND is governed here.
//  2. Width: a temporal line/area needs horizontal room — at a third-width the x-axis collapses into
//     sub-pixel mush (see the downsample note in CLAUDE.md). Such a viz may not render at 'third';
//     it is coerced UP to 'half' rather than silently dropping points.

import type { WidgetViz } from '@/lib/widgetMetrics';
import type { WidgetSize } from '@/lib/widgetPrefsStore';

/** Vizzes that may carry a tonal background: the single-metric story number and its single line. */
const TONAL_SURFACE_VIZ: ReadonlySet<WidgetViz> = new Set<WidgetViz>(['kpi', 'line']);

/** True when a viz is a single-metric story card that may sit on a tonal (accent) surface. Bars,
 *  pies/donuts, lists, ranks, pivots, tables and ledgers (Breakdown & Mentions ranking included)
 *  are false — neutral surface, accent on the series only. */
export function vizAllowsTonalSurface(viz: WidgetViz): boolean {
  return TONAL_SURFACE_VIZ.has(viz);
}

/** Effective tint after the surface policy: a saved tonal preference (default on) is honoured only
 *  for a viz the policy allows; every other viz is forced neutral. */
export function effectiveTinted(viz: WidgetViz, savedTinted: boolean | undefined): boolean {
  return (savedTinted ?? true) && vizAllowsTonalSurface(viz);
}

/** Vizzes that read as a temporal line/area and cannot survive a third-width footprint. */
const TEMPORAL_LINE_VIZ: ReadonlySet<WidgetViz> = new Set<WidgetViz>(['line']);

/** False when a viz is a temporal line/area that must not render at third width. */
export function vizAllowsThirdWidth(viz: WidgetViz): boolean {
  return !TEMPORAL_LINE_VIZ.has(viz);
}

/** Coerce a chosen size UP to the minimum the viz can render at — a temporal line at 'third' becomes
 *  'half' (never silently dropped to a size that mangles the x-axis). Everything else is unchanged. */
export function coerceSizeForViz(viz: WidgetViz, size: WidgetSize): WidgetSize {
  if (!vizAllowsThirdWidth(viz) && size === 'third') return 'half';
  return size;
}
