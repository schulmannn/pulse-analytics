/**
 * Детали метрик МойСклада для каталога (U05): тексты ⓘ, URL-схема контролов разбора и deps
 * запросов. Грузится лениво через loadMetricDetails('ms').
 *
 * URL-схемы записаны копией констант MsMetricPage (SUMMARY_URL, CHANNELS_URL, …): страница по
 * «потребители пока не меняются» их не читает. Когда разбор МС перейдёт на общее URL-состояние,
 * источником станет эта запись, а локальные константы страницы уйдут.
 */
import type { ExplorerUrlParam, MetricDetails, MetricExplorerSchema } from '@/lib/metricDetails';
import { MS_COHORT_MODES } from '@/lib/msCohortMode';
import { MS_METRIC_INFO } from '@/panels/sklad/msMetricInfo';

const GRAIN: ExplorerUrlParam = { values: ['day', 'week', 'month'], defaultValue: 'day' };
const CHART: ExplorerUrlParam = { values: ['line', 'bar'], defaultValue: 'line' };
const COMPARE: ExplorerUrlParam = { values: ['prev', 'off'], defaultValue: 'prev' };

const SUMMARY: MetricExplorerSchema = { url: { grain: GRAIN, chart: CHART, compare: COMPARE }, local: [] };
const customers = (defaultMetric: string): MetricExplorerSchema => ({
  url: {
    grain: GRAIN,
    chart: CHART,
    metric: { values: ['orders', 'revenue', 'repeatShare'], defaultValue: defaultMetric },
    compare: COMPARE,
  },
  local: [],
});
const COMPARE_ONLY: MetricExplorerSchema = { url: { compare: COMPARE }, local: [] };

export const details: MetricDetails = {
  info: MS_METRIC_INFO,
  explorerSchema: {
    'ms.revenue': SUMMARY,
    'ms.orders': SUMMARY,
    'ms.avgCheck': SUMMARY,
    'ms.customers': customers('orders'),
    'ms.repeat': customers('repeatShare'),
    'ms.rfm': {
      url: {
        // 'none' — сегмент не выбран (дефолт, из URL убирается); остальные — канон RFM_SEGMENTS.
        segment: {
          values: ['none', 'champions', 'loyal', 'potential', 'new', 'at_risk', 'hibernating'],
          defaultValue: 'none',
        },
        compare: COMPARE,
      },
      local: [],
    },
    'ms.channels': {
      url: {
        grain: GRAIN,
        chart: CHART,
        metric: { values: ['revenue', 'orders', 'aov'], defaultValue: 'revenue' },
        view: { values: ['aggregate', 'breakdown'], defaultValue: 'aggregate' },
        compare: COMPARE,
        // Выбранные каналы — UUID через запятую (msMetricUrlState.parseMsChannelIds).
        channels: { defaultValue: null },
      },
      local: [],
    },
    'ms.funnel': {
      url: { metric: { values: ['orders', 'revenue'], defaultValue: 'orders' }, compare: COMPARE },
      local: [],
    },
    'ms.products': {
      url: {
        view: { values: ['concentration', 'ranking', 'dynamics'], defaultValue: 'concentration' },
        sort: { values: ['revenue', 'profit', 'margin'], defaultValue: 'revenue' },
        concentration: { values: ['revenue', 'profit'], defaultValue: 'revenue' },
        change: { values: ['revenue', 'profit', 'units'], defaultValue: 'revenue' },
      },
      local: [],
    },
    'ms.returns': {
      url: {
        grain: GRAIN,
        chart: CHART,
        metric: { values: ['count', 'sum'], defaultValue: 'count' },
        compare: COMPARE,
      },
      local: [],
    },
    'ms.salesChannels': {
      url: { metric: { values: ['revenue', 'orders'], defaultValue: 'revenue' }, compare: COMPARE },
      local: [],
    },
    'ms.geography': COMPARE_ONLY,
    'ms.topCustomers': COMPARE_ONLY,
    'ms.cohorts': { url: { mode: { values: MS_COHORT_MODES, defaultValue: 'retention' } }, local: [] },
    'ms.stock': { url: { sort: { values: ['days', 'stock', 'sold'], defaultValue: 'days' } }, local: [] },
  },
  deps: {
    'ms.revenue': { widget: ['useMsSummary'], explorer: ['useMsSummary'] },
    'ms.orders': { widget: ['useMsSummary'], explorer: ['useMsSummary'] },
    'ms.avgCheck': { widget: ['useMsSummary'], explorer: ['useMsSummary'] },
    'ms.customers': { explorer: ['useMsCustomers'] },
    'ms.repeat': { explorer: ['useMsCustomers'] },
    'ms.rfm': { explorer: ['useMsRfm'] },
    'ms.channels': { explorer: ['useMsSalesByChannel', 'useMsChannelSeries'] },
    'ms.funnel': { explorer: ['useMsFunnel'] },
    'ms.products': { explorer: ['useMsTopProducts', 'useMsAssortmentComparison'] },
    'ms.returns': { explorer: ['useMsReturns'] },
    'ms.salesChannels': { explorer: ['useMsSalesByChannel'] },
    'ms.geography': { explorer: ['useMsGeography'] },
    'ms.topCustomers': { explorer: ['useMsTopCustomers'] },
    'ms.cohorts': { explorer: ['useMsCohorts'] },
    'ms.stock': { explorer: ['useMsStock'] },
  },
};
