/**
 * Детали метрик Telegram для каталога (U05): тексты ⓘ, URL-схема контролов разбора и deps
 * запросов. Грузится лениво через loadMetricDetails('tg') — в общий чанк не попадает (гейт
 * check-bundle-size). Записано по текущему коду; страницы эти детали пока не читают.
 */
import type { ExplorerUrlParam, MetricDetails, MetricExplorerSchema } from '@/lib/metricDetails';
import { TG_METRIC_INFO } from '@/panels/tgMetricInfo';

const GRAIN: ExplorerUrlParam = { values: ['day', 'week', 'month'], defaultValue: 'day' };
const CMP: ExplorerUrlParam = { values: ['off', 'prev', 'year'], defaultValue: 'prev' };
const CAMPAIGN: ExplorerUrlParam = { defaultValue: null };

/** MetricPage: вид, грануляция, база сравнения и измерение rank/pivot — в URL (без канонизации:
 *  неизвестное значение читается как дефолт и остаётся в строке). */
const CORE: MetricExplorerSchema = {
  url: {
    chart: { values: ['line', 'bar', 'rank', 'pivot'], defaultValue: 'line' },
    grain: GRAIN,
    cmp: CMP,
    dim: { values: ['format', 'weekday'], defaultValue: 'format' },
  },
  local: [],
};
const NONE: MetricExplorerSchema = { url: {}, local: [] };
/** Категориальные ряды и скорость набора: тип графика — локальный useState. */
const LOCAL_CHART: MetricExplorerSchema = { url: {}, local: ['chart'] };
/** Разрезы контента: выбранная кампания приходит в `?campaign=`. */
const CAMPAIGN_SCOPED: MetricExplorerSchema = { url: { campaign: CAMPAIGN }, local: [] };

const CORE_WIDGET = ['useTgFull', 'useHistory', 'useChannels'] as const;
const CORE_EXPLORER = ['useTgFull', 'useHistory', 'useChannels', 'useAnnotations'] as const;
/** Резолвер разбивок Главной сначала требует посты (tg-full), потом читает графики. */
const GRAPHS_WIDGET = ['useTgFull', 'useTgGraphs'] as const;

export const details: MetricDetails = {
  info: TG_METRIC_INFO,
  explorerSchema: {
    'tg.views': CORE,
    'tg.subscribers': { url: { grain: GRAIN, cmp: CMP }, local: [] },
    'tg.avgReach': CORE,
    'tg.reactions': CORE,
    'tg.forwards': CORE,
    'tg.er': CORE,
    'tg.heatmap': NONE,
    'tg.velocity': LOCAL_CHART,
    'tg.contentOpportunity': CAMPAIGN_SCOPED,
    'tg.weekdayReach': LOCAL_CHART,
    'tg.weekdayViews': LOCAL_CHART,
    'tg.postCount': LOCAL_CHART,
    'tg.hours': LOCAL_CHART,
    'tg.formatViews': NONE,
    'tg.hashtagErv': CAMPAIGN_SCOPED,
    'tg.emoji': CAMPAIGN_SCOPED,
    'tg.engagementComposition': CAMPAIGN_SCOPED,
    'tg.viewsByType': CAMPAIGN_SCOPED,
    'tg.formatPerf': CAMPAIGN_SCOPED,
    'tg.viewsBySource': NONE,
    'tg.newFollowersBySource': NONE,
    'tg.languages': NONE,
    'tg.sentiment': NONE,
    'tg.churn': NONE,
  },
  deps: {
    'tg.views': { widget: CORE_WIDGET, explorer: CORE_EXPLORER },
    'tg.subscribers': { widget: CORE_WIDGET, explorer: CORE_EXPLORER },
    'tg.avgReach': { widget: CORE_WIDGET, explorer: CORE_EXPLORER },
    'tg.reactions': { widget: CORE_WIDGET, explorer: CORE_EXPLORER },
    'tg.forwards': { widget: CORE_WIDGET, explorer: CORE_EXPLORER },
    'tg.er': { widget: CORE_WIDGET, explorer: CORE_EXPLORER },
    'tg.erv': { widget: ['useTgFull'] },
    'tg.virality': { widget: ['useTgFull'] },
    // STATES-5: виджет гейтит ошибку только по tg-full и history — сбой графиков читается как пустота.
    'tg.netGrowth': { widget: ['useTgGraphs'] },
    // Резолвер «unavailable»: на Главной эти таблицы не рисуются.
    'tg.weeklyTable': { widget: [] },
    'tg.topPosts': { widget: [] },
    'tg.heatmap': { explorer: ['useTgFull'] },
    'tg.velocity': { explorer: ['useVelocity'] },
    'tg.contentOpportunity': { explorer: ['useTgFull', 'useCampaignPosts'] },
    'tg.weekdayReach': { explorer: ['useTgFull'] },
    'tg.weekdayViews': { widget: ['useTgFull'], explorer: ['useTgFull'] },
    'tg.postCount': { widget: ['useTgFull'], explorer: ['useTgFull'] },
    'tg.hours': { widget: GRAPHS_WIDGET, explorer: ['useTgGraphs'] },
    'tg.formatViews': { explorer: ['useTgFull'] },
    'tg.hashtagErv': { explorer: ['useTgFull', 'useCampaignPosts'] },
    'tg.emoji': { widget: ['useTgFull'], explorer: ['useTgFull', 'useCampaignPosts'] },
    'tg.engagementComposition': { widget: ['useTgFull'], explorer: ['useTgFull', 'useCampaignPosts'] },
    'tg.viewsByType': { widget: ['useTgFull'], explorer: ['useTgFull', 'useCampaignPosts'] },
    'tg.formatPerf': { widget: ['useTgFull'], explorer: ['useTgFull', 'useCampaignPosts'] },
    'tg.viewsBySource': { widget: GRAPHS_WIDGET, explorer: ['useTgGraphs'] },
    'tg.newFollowersBySource': { widget: GRAPHS_WIDGET, explorer: ['useTgGraphs'] },
    'tg.languages': { widget: GRAPHS_WIDGET, explorer: ['useTgGraphs'] },
    'tg.sentiment': { widget: GRAPHS_WIDGET, explorer: ['useTgGraphs'] },
    'tg.churn': { widget: GRAPHS_WIDGET, explorer: ['useTgGraphs'] },
  },
};
