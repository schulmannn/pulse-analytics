/**
 * Детали метрик Яндекс.Метрики для каталога (U05): тексты ⓘ, URL-схема контролов разбора и deps
 * запросов. Грузится лениво через loadMetricDetails('ym'). Записано по текущему коду: окно, тип
 * графика и база сравнения дневных рядов и выбранная цель атрибуции живут в useState (SHELL-4).
 */
import type { MetricDetails, MetricExplorerSchema } from '@/lib/metricDetails';
import { YM_METRIC_INFO } from '@/panels/metrika/ymMetricInfo';

const NONE: MetricExplorerSchema = { url: {}, local: [] };
const DAILY: MetricExplorerSchema = { url: {}, local: ['window', 'chart', 'compare'] };
const GOAL: MetricExplorerSchema = { url: {}, local: ['goal'] };

/** Разрез с селектором цели: словарь целей грузится только у него. */
const withGoals = (hook: string): readonly string[] => [hook, 'useYmGoals'];

export const details: MetricDetails = {
  info: YM_METRIC_INFO,
  explorerSchema: {
    'ym.visits': DAILY,
    'ym.users': DAILY,
    'ym.pageviews': DAILY,
    'ym.hourly': NONE,
    'ym.sources': GOAL,
    'ym.referrers': NONE,
    'ym.social': NONE,
    'ym.messengers': NONE,
    'ym.devices': GOAL,
    'ym.countries': NONE,
    'ym.cities': NONE,
    'ym.age': NONE,
    'ym.gender': NONE,
    'ym.goals': NONE,
    'ym.utm': GOAL,
    'ym.pages': NONE,
    'ym.landings': GOAL,
    'ym.exits': NONE,
  },
  deps: {
    // Дневной разбор читает весь архив ym_daily («Всё») и режет окно на клиенте.
    'ym.visits': { widget: ['useYmSummary'], explorer: ['useYmSummary'] },
    'ym.users': { widget: ['useYmSummary'], explorer: ['useYmSummary'] },
    'ym.pageviews': { widget: ['useYmSummary'], explorer: ['useYmSummary'] },
    'ym.hourly': { explorer: ['useYmHourly'] },
    'ym.sources': { explorer: withGoals('useYmSources') },
    'ym.referrers': { explorer: ['useYmReferrers'] },
    'ym.social': { explorer: ['useYmSocial'] },
    'ym.messengers': { explorer: ['useYmMessengers'] },
    'ym.devices': { explorer: withGoals('useYmDevices') },
    'ym.countries': { explorer: ['useYmCountries'] },
    'ym.cities': { explorer: ['useYmCities'] },
    'ym.age': { explorer: ['useYmAge'] },
    'ym.gender': { explorer: ['useYmGender'] },
    'ym.goals': { explorer: ['useYmGoals'] },
    'ym.utm': { explorer: withGoals('useYmUtm') },
    'ym.pages': { explorer: ['useYmPages'] },
    'ym.landings': { explorer: withGoals('useYmLandings') },
    'ym.exits': { explorer: ['useYmExits'] },
  },
};
