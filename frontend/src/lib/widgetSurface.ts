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

/** Тинт КУРАТИРУЕМОЙ (не config-driven) карточки, когда пользователь ничего не сохранял.
 *
 *  Канон: дефолт — нейтральная поверхность, тинт — ручной инструмент ОДНОЙ истории страницы.
 *  Поэтому у карточки С акцентом дефолт объявляет хост (`defaultTinted`, по умолчанию выключен) —
 *  доска из пяти разноцветных заливок сразу обесценивает цвет. У карточки БЕЗ акцента заливать
 *  нечем: её `--card-tint`-подложка — базовая поверхность карточки, а не история, и остаётся
 *  включённой.
 *
 *  ВАЖНО: `defaultColor` — акцент, ОБЪЯВЛЕННЫЙ ХОСТОМ в JSX, а не эффективный акцент карточки.
 *  Дефолт описывает вид карточки «из коробки»; подставить сюда сохранённый пользователем цвет
 *  значит снять заливку у того, кто выбрал акцент, но переключатель не трогал.
 *
 *  Сохранённый выбор пользователя (`pulse_widget_prefs.tinted`) всегда главнее дефолта. */
export function defaultWidgetTint(defaultColor: number | undefined, defaultTinted: boolean | undefined): boolean {
  return defaultColor ? (defaultTinted ?? false) : true;
}

/** Эффективный тинт карточки: СОХРАНЁННЫЙ выбор пользователя главнее дефолта хоста, и только
 *  отсутствующий (`undefined`) выбор падает в `defaultWidgetTint` (с тем же объявленным хостом
 *  акцентом). Смена дефолта поэтому НИКОГДА не перекрашивает карточку, которую пользователь уже
 *  настроил руками (prefs не мигрируются). */
export function resolveWidgetTint(
  savedTinted: boolean | undefined,
  defaultColor: number | undefined,
  defaultTinted: boolean | undefined,
): boolean {
  return savedTinted ?? defaultWidgetTint(defaultColor, defaultTinted);
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
