// The metric catalogue — one canonical `MetricDef[]` describing WHAT every dashboard number is
// (its label, source, shape, unit, default + allowed visualisations, breakdown dimensions and
// category). It unifies knowledge that until now lived scattered across three places:
//
//   - metricDefs.ts  → the plain-language «что значит» texts (formula / included / source note);
//   - kpiDerive.ts   → the six KPI DrillKeys (views / subscribers / avgReach / reactions /
//                      forwards / er) and their per-post attribution fields;
//   - TgAnalytics.tsx / igMetrics.ts → the derived + breakdown metrics (ERV, virality, net-growth,
//                      churn, sources, languages, sentiment, formats, IG reach / followers /
//                      demographics …) that are today hard-wired into individual widgets.
//
// This file is PURE DATA + TYPES — no React, no fetching, no formatting — so it is unit-testable
// and can be consumed by the resolver (S3), the universal editor (S5) and the catalogue modal
// (S6) without pulling in the UI. It does NOT compute anything: a MetricDef says what a metric IS,
// not how to fetch it (that mapping is the resolver's job). Nothing renders off it yet — wiring
// lands in later sprints; this sprint only establishes the vocabulary.

import type { DrillKey } from '@/lib/kpiDerive';
import type { WidgetSize } from '@/components/ChartWidget';

/** Where the metric's data comes from. `all` = source-agnostic (rare; reserved). */
export type MetricSource = 'tg' | 'ig' | 'all';

/** The metric's natural data shape — drives which visualisations make sense.
 *   - value      → a scalar (+ optional delta): a KPI headline (ER now, ERV, virality);
 *   - series     → a time series (+ a headline sum/last): views, subscribers, reactions;
 *   - breakdown  → a categorical split: emoji, sources, languages, formats, demographics;
 *   - table      → tabular rows: the weekly table, top posts. */
export type MetricKind = 'value' | 'series' | 'breakdown' | 'table';

/** Formatting family for a metric's numbers (the plan's number/percent/posts/views set). */
export type MetricUnit = 'number' | 'percent' | 'posts' | 'views';

/** The unified visualisation vocabulary. `donut` = PieChart, `list` = Breakdown rows,
 *  `rank`/`pivot` = the metric-page dimension projections, `ledger` = the wide bar+values row. */
export type WidgetViz = 'kpi' | 'line' | 'bar' | 'donut' | 'list' | 'rank' | 'pivot' | 'table' | 'ledger';

/** Catalogue grouping (steep sidebar / the add-widget modal). Informed by the existing TG tabs
 *  (Динамика / Контент / Аудитория) but split into the plan's four buckets. */
export type MetricCategory = 'growth' | 'engagement' | 'content' | 'audience';

/** How a series combines across grain buckets (S10): flow metrics SUM (views, reactions), level
 *  metrics take the LAST value in the bucket (subscribers, followers) — summing a level over a
 *  quarter would be nonsense. Default `flow`. */
export type SeriesAggregation = 'flow' | 'level';

export interface MetricDef {
  /** Stable, source-namespaced id (e.g. `tg.views`, `ig.reach`). The WidgetConfig references this. */
  id: string;
  /** Display title (matches the card label users already know). */
  label: string;
  source: MetricSource;
  kind: MetricKind;
  unit: MetricUnit;
  category: MetricCategory;
  /** The presentation a fresh widget of this metric opens with. Always ∈ `supportedViz`. */
  defaultViz: WidgetViz;
  /** Every presentation this metric may be shown as (drives the editor's type carousel). */
  supportedViz: WidgetViz[];
  /** Breakdown dimensions this metric can split by (dimension ids; the catalogue is formalised in
   *  S7). Only meaningful for series/breakdown metrics with per-item attribution. */
  dimensions?: string[];
  /** Grain-combination rule for series metrics (S10). Omitted → `flow`. */
  seriesAgg?: SeriesAggregation;
  /** Ties a core TG metric to its kpiDerive DrillKey so the resolver (S3) reuses deriveKpis for the
   *  value/delta/headline without re-deriving. Only the six KPI metrics carry this. */
  drillKey?: DrillKey;
  // ── Plain-language definition (ported from metricDefs.ts; surfaced in the «О метрике» block) ──
  /** How it's calculated, in words. */
  formula?: string;
  /** What's included / a clarifying note. */
  included?: string;
  /** Where the number comes from (renamed from metricDefs' `source` to avoid clashing with the
   *  `source` tg/ig/all field above). */
  sourceNote?: string;
}

/** Default viz set per kind — a metric may override, but this keeps the catalogue consistent and
 *  DRY (same spirit as reportBlocks' defaultBlock switch). A series metric that declares
 *  `dimensions` also gains rank/pivot (the metric-page projections). */
function vizForKind(kind: MetricKind): { defaultViz: WidgetViz; supportedViz: WidgetViz[] } {
  switch (kind) {
    case 'value':
      return { defaultViz: 'kpi', supportedViz: ['kpi'] };
    // rank/pivot (dimension projections) are NOT rendered from a WidgetResult — the resolver produces
    // no rank/pivot shape — so the builder only offers line/bar for series (no dead viz options).
    case 'series':
      return { defaultViz: 'line', supportedViz: ['line', 'bar'] };
    case 'breakdown':
      return { defaultViz: 'list', supportedViz: ['list', 'bar', 'donut'] };
    case 'table':
      return { defaultViz: 'table', supportedViz: ['table'] };
  }
}

/** Catalogue-entry spec: everything except the viz set, which `vizForKind` fills unless the entry
 *  overrides `defaultViz` / `supportedViz`. */
type MetricSpec = Omit<MetricDef, 'defaultViz' | 'supportedViz'> &
  Partial<Pick<MetricDef, 'defaultViz' | 'supportedViz'>>;

function define(spec: MetricSpec): MetricDef {
  const auto = vizForKind(spec.kind);
  const supportedViz = spec.supportedViz ?? auto.supportedViz;
  const defaultViz = spec.defaultViz ?? auto.defaultViz;
  return { ...spec, defaultViz, supportedViz };
}

// Dimensions shared by the post-attributed TG series metrics (format / weekday) — the metric page
// already breaks these down (RankChart / PivotTable). The dimension catalogue is formalised in S7.
const POST_DIMS = ['tg.format', 'tg.weekday'];

// ── Telegram ────────────────────────────────────────────────────────────────────────────────
const TG_METRICS: MetricDef[] = [
  // Core KPI / DrillKey metrics — series with a reconciled headline (deriveKpis). Texts ported
  // from metricDefs.ts so the «О метрике» block reads the same.
  define({
    id: 'tg.views', label: 'Просмотры', source: 'tg', kind: 'series', unit: 'views',
    category: 'engagement', dimensions: POST_DIMS, drillKey: 'views',
    formula: 'Сумма просмотров всех постов в выбранном окне.', sourceNote: 'Посты канала (MTProto).',
  }),
  define({
    id: 'tg.subscribers', label: 'Подписчики', source: 'tg', kind: 'series', unit: 'number',
    category: 'growth', seriesAgg: 'level', drillKey: 'subscribers',
    formula: 'Текущее число подписчиков канала.',
    included: 'Δ — изменение за период (из дневного архива), а не разница «сейчас минус показанное».',
    sourceNote: 'Дневной архив channel_daily.',
  }),
  define({
    id: 'tg.avgReach', label: 'Средний охват поста', source: 'tg', kind: 'series', unit: 'views',
    category: 'engagement', dimensions: POST_DIMS, drillKey: 'avgReach',
    formula: 'Просмотры за период ÷ число постов в окне.', sourceNote: 'Посты канала.',
  }),
  define({
    id: 'tg.reactions', label: 'Реакции', source: 'tg', kind: 'series', unit: 'number',
    category: 'engagement', dimensions: POST_DIMS, drillKey: 'reactions',
    formula: 'Сумма всех реакций-эмодзи под постами окна.',
  }),
  define({
    id: 'tg.forwards', label: 'Репосты', source: 'tg', kind: 'series', unit: 'number',
    category: 'engagement', dimensions: POST_DIMS, drillKey: 'forwards',
    formula: 'Сколько раз посты переслали (forward) за период.',
  }),
  define({
    id: 'tg.er', label: 'Вовлечённость (ER)', source: 'tg', kind: 'value', unit: 'percent',
    category: 'engagement', drillKey: 'er',
    formula: 'ER = (реакции + репосты + комментарии) ÷ подписчики × 100%.',
    included: 'Доля подписчиков, как-либо отреагировавших на посты периода.',
  }),
  // Derived post-average KPIs (no clean daily series — shown as headline values).
  define({
    id: 'tg.erv', label: 'ERV', source: 'tg', kind: 'value', unit: 'percent', category: 'engagement',
    formula: 'ERV = (реакции + репосты + комментарии) ÷ просмотры × 100%.',
    included: 'Вовлечённость на просмотр (а не на подписчика) — устойчивее к охвату.',
  }),
  define({
    id: 'tg.virality', label: 'Виральность', source: 'tg', kind: 'value', unit: 'percent',
    category: 'engagement',
    formula: 'Виральность = репосты ÷ просмотры × 100%.',
    included: 'Насколько активно контент разносят дальше.',
  }),
  // Growth flows.
  define({
    id: 'tg.netGrowth', label: 'Чистый прирост подписчиков', source: 'tg', kind: 'series', unit: 'number',
    category: 'growth', defaultViz: 'bar', supportedViz: ['bar', 'line'],
    formula: 'Подписавшиеся − отписавшиеся за каждый день.', sourceNote: 'График подписчиков (MTProto).',
  }),
  define({
    id: 'tg.churn', label: 'Динамика оттока', source: 'tg', kind: 'breakdown', unit: 'number',
    category: 'growth',
    formula: 'Всего подписавшихся против всего отписавшихся за период.',
  }),
  define({
    id: 'tg.newFollowersBySource', label: 'Новые подписчики по источникам', source: 'tg', kind: 'breakdown',
    unit: 'number', category: 'audience',
    formula: 'Откуда пришли новые подписчики (подписки / ссылки / поиск / …).',
  }),
  // Content breakdowns.
  define({
    id: 'tg.emoji', label: 'Реакции по эмодзи', source: 'tg', kind: 'breakdown', unit: 'number',
    category: 'content', dimensions: POST_DIMS, formula: 'Топ эмодзи-реакций под постами окна.',
  }),
  define({
    id: 'tg.engagementComposition', label: 'Состав вовлечённости', source: 'tg', kind: 'breakdown',
    unit: 'number', category: 'engagement',
    formula: 'Реакции против репостов против комментариев за период.',
  }),
  define({
    id: 'tg.viewsByType', label: 'Ср. охват по типу', source: 'tg', kind: 'breakdown', unit: 'views',
    category: 'content', formula: 'Средние просмотры по типу поста (фото / видео / …).',
  }),
  define({
    id: 'tg.formatPerf', label: 'Вовлечённость по формату', source: 'tg', kind: 'breakdown', unit: 'percent',
    category: 'content', dimensions: ['tg.weekday'],
    formula: 'Средний ERV по типу поста — какие форматы реально вовлекают.',
  }),
  define({
    id: 'tg.weekdayViews', label: 'По дням недели', source: 'tg', kind: 'breakdown', unit: 'views',
    category: 'content', defaultViz: 'bar', supportedViz: ['bar', 'line'], dimensions: ['tg.format'],
    formula: 'Средние просмотры поста по дню недели публикации.',
  }),
  define({
    id: 'tg.postCount', label: 'Количество постов', source: 'tg', kind: 'breakdown', unit: 'posts',
    category: 'content', defaultViz: 'bar', supportedViz: ['bar', 'line'], dimensions: ['tg.format'],
    formula: 'Сколько постов вышло по дню недели.',
  }),
  // Audience breakdowns.
  define({
    id: 'tg.viewsBySource', label: 'Просмотры по источникам', source: 'tg', kind: 'breakdown', unit: 'views',
    category: 'audience', formula: 'Откуда пришли просмотры (подписчики / ссылки / поиск / …).',
  }),
  define({
    id: 'tg.languages', label: 'Языки аудитории', source: 'tg', kind: 'breakdown', unit: 'number',
    category: 'audience', formula: 'Языки интерфейса подписчиков (топ-8).',
  }),
  define({
    id: 'tg.sentiment', label: 'Тональность реакций', source: 'tg', kind: 'breakdown', unit: 'number',
    category: 'audience', formula: 'Положительные / нейтральные / отрицательные реакции.',
  }),
  define({
    id: 'tg.hours', label: 'Активность по часам', source: 'tg', kind: 'breakdown', unit: 'number',
    category: 'audience', defaultViz: 'bar', supportedViz: ['bar', 'line'],
    formula: 'Просмотры по часу суток — когда аудитория активнее.',
  }),
  // Tables (also the report presets).
  define({
    id: 'tg.weeklyTable', label: 'По неделям', source: 'tg', kind: 'table', unit: 'number',
    category: 'engagement', formula: 'Понедельные суммы просмотров / реакций / репостов.',
  }),
  define({
    id: 'tg.topPosts', label: 'Топ постов', source: 'tg', kind: 'table', unit: 'views',
    category: 'content', formula: 'Лучшие публикации периода по вовлечённости.',
  }),
];

// ── Instagram ───────────────────────────────────────────────────────────────────────────────
const IG_METRICS: MetricDef[] = [
  define({
    id: 'ig.reach', label: 'Охват', source: 'ig', kind: 'series', unit: 'views', category: 'engagement',
    formula: 'Уникальные аккаунты, увидевшие контент за период.', sourceNote: 'Instagram Graph (insights).',
  }),
  define({
    id: 'ig.followers', label: 'Подписчики', source: 'ig', kind: 'series', unit: 'number', category: 'growth',
    seriesAgg: 'level', formula: 'Текущее число подписчиков аккаунта.', sourceNote: 'Instagram Graph.',
  }),
  define({
    id: 'ig.netFollowers', label: 'Прирост подписчиков', source: 'ig', kind: 'series', unit: 'number',
    category: 'growth', defaultViz: 'bar', supportedViz: ['bar', 'line'],
    formula: 'Дневной чистый прирост подписчиков (follower_count).',
  }),
  define({
    id: 'ig.erv', label: 'Вовлечённость (ERV)', source: 'ig', kind: 'value', unit: 'percent',
    category: 'engagement',
    formula: 'ERV = взаимодействия ÷ охват × 100%.',
    included: 'Вовлечённость на охват — устойчивее к размеру аудитории.',
  }),
  define({
    id: 'ig.interactions', label: 'Взаимодействия', source: 'ig', kind: 'series', unit: 'number',
    category: 'engagement',
    formula: 'Лайки + комментарии + сохранения + репосты за период.',
  }),
  define({
    id: 'ig.formats', label: 'Форматы', source: 'ig', kind: 'breakdown', unit: 'number', category: 'content',
    formula: 'Распределение публикаций по типу (Лента / Reels / Stories / Карусель).',
  }),
  define({
    id: 'ig.age', label: 'Возраст', source: 'ig', kind: 'breakdown', unit: 'number', category: 'audience',
    defaultViz: 'bar', supportedViz: ['bar', 'list', 'donut'],
    formula: 'Распределение подписчиков по возрастным группам.', sourceNote: 'Instagram Graph (demographics).',
  }),
  define({
    id: 'ig.gender', label: 'Пол', source: 'ig', kind: 'breakdown', unit: 'number', category: 'audience',
    formula: 'Распределение подписчиков по полу.', sourceNote: 'Instagram Graph (demographics).',
  }),
  define({
    id: 'ig.countries', label: 'Страны', source: 'ig', kind: 'breakdown', unit: 'number', category: 'audience',
    defaultViz: 'donut', supportedViz: ['donut', 'list', 'bar'],
    formula: 'Топ стран аудитории.', sourceNote: 'Instagram Graph (demographics).',
  }),
  define({
    id: 'ig.cities', label: 'Города', source: 'ig', kind: 'breakdown', unit: 'number', category: 'audience',
    formula: 'Топ городов аудитории.', sourceNote: 'Instagram Graph (demographics).',
  }),
  define({
    id: 'ig.hours', label: 'Лучшее время', source: 'ig', kind: 'breakdown', unit: 'number', category: 'audience',
    defaultViz: 'bar', supportedViz: ['bar', 'line'],
    formula: 'Когда подписчики онлайн (по часам).', sourceNote: 'Instagram Graph (online_followers).',
  }),
];

/** The full catalogue — TG first, then IG, in a sensible reading order per source. */
export const WIDGET_METRICS: MetricDef[] = [...TG_METRICS, ...IG_METRICS];

/** id → MetricDef for O(1) lookup (the WidgetConfig resolves its metric through this). */
export const METRIC_BY_ID: Record<string, MetricDef> = Object.fromEntries(
  WIDGET_METRICS.map((m) => [m.id, m]),
);

export function getMetric(id: string): MetricDef | undefined {
  return METRIC_BY_ID[id];
}

export function isMetricId(raw: string | undefined | null): raw is string {
  return typeof raw === 'string' && raw in METRIC_BY_ID;
}

/** Metrics available for a source: `tg` / `ig` themselves plus any `all` (source-agnostic) ones. */
export function metricsForSource(source: 'tg' | 'ig'): MetricDef[] {
  return WIDGET_METRICS.filter((m) => m.source === source || m.source === 'all');
}

/** A sensible default footprint for a fresh widget of this metric (U4): a KPI reads at a third, a
 *  donut wants a compact square, a table needs the full row, everything else (line/bar/list) a half.
 *  Seeds `defaultWidget().size` so a new card lands well-proportioned instead of always half. */
export function recommendedSize(metric: MetricDef): WidgetSize {
  if (metric.kind === 'table') return 'full';
  if (metric.kind === 'value') return 'third';
  if (metric.defaultViz === 'donut') return 'third';
  return 'half';
}

/** Human labels + display order for the four catalogue categories (S6 modal groups / headers). */
export const CATEGORY_LABEL: Record<MetricCategory, string> = {
  growth: 'Рост',
  engagement: 'Вовлечённость',
  content: 'Контент',
  audience: 'Аудитория',
};
export const CATEGORY_ORDER: MetricCategory[] = ['growth', 'engagement', 'content', 'audience'];
