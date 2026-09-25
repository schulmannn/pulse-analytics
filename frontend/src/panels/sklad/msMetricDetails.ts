/**
 * Детали метрик МойСклада для каталога (U05): тексты ⓘ, URL-схема контролов разбора и deps
 * запросов. Грузится лениво через loadMetricDetails('ms').
 *
 * URL-схема разбора — не копия: она строится из тех же констант (msMetricUrlSchemas.ts), которыми
 * MsMetricPage разбирает свой URL, поэтому разойтись со страницей не может.
 */
import type { MetricDetails, MetricExplorerSchema } from '@/lib/metricDetails';
import type { MsMetricUrlSchema } from '@/lib/msMetricUrlState';
import { MS_METRIC_INFO } from '@/panels/sklad/msMetricInfo';
import {
  CHANNELS_URL,
  COHORTS_URL,
  COMPARE_URL,
  CONTRIBUTION_URL,
  FUNNEL_URL,
  PRODUCTS_URL,
  RETURNS_URL,
  RFM_URL,
  STOCK_URL,
  SUMMARY_URL,
  customersUrl,
} from '@/panels/sklad/msMetricUrlSchemas';

/** Схема страницы → схема каталога. Выбранные каналы — UUID через запятую
 *  (msMetricUrlState.parseMsChannelIds): свободное значение без дефолта. */
function explorer(schema: MsMetricUrlSchema): MetricExplorerSchema {
  return {
    url: { ...schema.enums, ...(schema.channels ? { channels: { defaultValue: null } } : {}) },
    local: [],
  };
}

export const details: MetricDetails = {
  info: MS_METRIC_INFO,
  explorerSchema: {
    'ms.revenue': explorer(SUMMARY_URL),
    'ms.orders': explorer(SUMMARY_URL),
    'ms.avgCheck': explorer(SUMMARY_URL),
    // MsMetricPage: <MsCustomerPage defaultMetric="orders" | "repeatShare">.
    'ms.customers': explorer(customersUrl('orders')),
    'ms.repeat': explorer(customersUrl('repeatShare')),
    'ms.rfm': explorer(RFM_URL),
    'ms.channels': explorer(CHANNELS_URL),
    'ms.funnel': explorer(FUNNEL_URL),
    'ms.products': explorer(PRODUCTS_URL),
    'ms.returns': explorer(RETURNS_URL),
    'ms.salesChannels': explorer(CONTRIBUTION_URL),
    'ms.geography': explorer(COMPARE_URL),
    'ms.topCustomers': explorer(COMPARE_URL),
    'ms.cohorts': explorer(COHORTS_URL),
    'ms.stock': explorer(STOCK_URL),
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
