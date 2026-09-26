/**
 * Детали метрик Instagram для каталога (U05): тексты ⓘ, URL-схема контролов разбора и deps
 * запросов. Грузится лениво через loadMetricDetails('ig'). Записано по текущему коду: окно, тип
 * графика и база сравнения дневных разборов пока живут в useState страницы (SHELL-4).
 */
import type { MetricDetails, MetricExplorerSchema } from '@/lib/metricDetails';
import { IG_METRIC_INFO } from '@/panels/igMetricInfo';

const NONE: MetricExplorerSchema = { url: {}, local: [] };
const DAILY: MetricExplorerSchema = { url: {}, local: ['window', 'chart', 'compare'] };
const CAMPAIGN_SCOPED: MetricExplorerSchema = { url: { campaign: { defaultValue: null } }, local: [] };

/** useIgData гейтит загрузку и ошибку каждой страницы /metrics/ig-* по профилю и инсайтам. */
const GATE = ['useIgProfile', 'useIgInsights'] as const;

export const details: MetricDetails = {
  info: IG_METRIC_INFO,
  explorerSchema: {
    'ig.reach': DAILY,
    'ig.followers': { url: {}, local: ['window'] },
    'ig.views': DAILY,
    'ig.interactions': DAILY,
    'ig.likes': DAILY,
    'ig.saves': DAILY,
    'ig.er': NONE,
    'ig.age': NONE,
    'ig.gender': NONE,
    'ig.countries': NONE,
    'ig.cities': NONE,
    'ig.hours': NONE,
    'ig.formats': CAMPAIGN_SCOPED,
    'ig.reelsWatchTime': CAMPAIGN_SCOPED,
    'ig.storyNavigation': NONE,
  },
  deps: {
    'ig.reach': { widget: ['useIgInsights', 'useIgHistory'], explorer: [...GATE, 'useIgHistory'] },
    'ig.followers': { widget: ['useIgProfile', 'useIgHistory'], explorer: [...GATE, 'useIgHistory'] },
    // Движение базы в виджете — архив ig_daily (follows − unfollows) с живым хвостом.
    'ig.netFollowers': { widget: ['useIgInsights', 'useIgHistory'] },
    'ig.erv': { widget: ['useIgInsights', 'useIgHistory'] },
    'ig.interactions': { widget: ['useIgInsights', 'useIgHistory'], explorer: [...GATE, 'useIgHistory'] },
    'ig.views': { explorer: [...GATE, 'useIgHistory'] },
    'ig.likes': { explorer: [...GATE, 'useIgHistory'] },
    'ig.saves': { explorer: [...GATE, 'useIgHistory'] },
    // ER архивного окна («Всё», свой период) считается из архива ig_daily.
    'ig.er': { explorer: [...GATE, 'useIgHistory'] },
    'ig.formats': {
      widget: ['useIgBreakdowns'],
      explorer: [...GATE, 'useIgBreakdowns', 'useIgPosts', 'useCampaignPosts'],
    },
    'ig.age': { widget: ['useIgBreakdowns'], explorer: [...GATE, 'useIgBreakdowns'] },
    'ig.gender': { widget: ['useIgBreakdowns'], explorer: [...GATE, 'useIgBreakdowns'] },
    'ig.countries': { widget: ['useIgBreakdowns'], explorer: [...GATE, 'useIgBreakdowns'] },
    'ig.cities': { widget: ['useIgBreakdowns'], explorer: [...GATE, 'useIgBreakdowns'] },
    'ig.hours': { widget: ['useIgOnline'], explorer: [...GATE, 'useIgOnline'] },
    'ig.reelsWatchTime': { explorer: [...GATE, 'useIgPosts', 'useCampaignPosts'] },
    'ig.storyNavigation': { explorer: [...GATE, 'useIgStories'] },
  },
};
