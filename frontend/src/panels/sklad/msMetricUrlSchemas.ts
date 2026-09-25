/**
 * URL-схемы контролов полного разбора МойСклада (`/metrics/ms-*`) — один источник для страницы
 * (MsMetricPage читает их через parseMsMetricUrl) и для деталей каталога (msMetricDetails, U05):
 * копии, которая могла бы разойтись со страницей, нет. PeriodUrlSync владеет p/from/to; здесь —
 * только контролы внутри страницы.
 */
import { MS_COHORT_MODES } from '@/lib/msCohortMode';
import type { MsMetricUrlSchema } from '@/lib/msMetricUrlState';

const GRAIN = { values: ['day', 'week', 'month'], defaultValue: 'day' } as const;
const CHART = { values: ['line', 'bar'], defaultValue: 'line' } as const;
const COMPARE = { values: ['prev', 'off'], defaultValue: 'prev' } as const;
export const SUMMARY_URL: MsMetricUrlSchema = { enums: { grain: GRAIN, chart: CHART, compare: COMPARE } };
/** Клиенты / повторные: у каждой страницы свой показатель по умолчанию. */
export function customersUrl(defaultMetric: string): MsMetricUrlSchema {
  return {
    enums: {
      grain: GRAIN,
      chart: CHART,
      metric: { values: ['orders', 'revenue', 'repeatShare'], defaultValue: defaultMetric },
      compare: COMPARE,
    },
  };
}
export const CHANNELS_URL: MsMetricUrlSchema = {
  enums: {
    grain: GRAIN,
    chart: CHART,
    metric: { values: ['revenue', 'orders', 'aov'], defaultValue: 'revenue' },
    view: { values: ['aggregate', 'breakdown'], defaultValue: 'aggregate' },
    compare: COMPARE,
  },
  channels: true,
};
export const FUNNEL_URL: MsMetricUrlSchema = {
  enums: { metric: { values: ['orders', 'revenue'], defaultValue: 'orders' }, compare: COMPARE },
};
export const PRODUCTS_URL: MsMetricUrlSchema = {
  enums: {
    view: { values: ['concentration', 'ranking', 'dynamics'], defaultValue: 'concentration' },
    sort: { values: ['revenue', 'profit', 'margin'], defaultValue: 'revenue' },
    concentration: { values: ['revenue', 'profit'], defaultValue: 'revenue' },
    // Метрика изменения на вкладке «Динамика»; сервер отдаёт все три сразу, поэтому это чистый
    // клиентский переключатель, не влияющий на запрос/кэш.
    change: { values: ['revenue', 'profit', 'units'], defaultValue: 'revenue' },
  },
};
export const STOCK_URL: MsMetricUrlSchema = {
  // Только клиентская сортировка таблицы: запрос/кэш от неё не зависят (сервер всегда отдаёт
  // порядок по срочности), поэтому compare/grain здесь нет.
  enums: { sort: { values: ['days', 'stock', 'sold'], defaultValue: 'days' } },
};
export const RETURNS_URL: MsMetricUrlSchema = {
  enums: {
    grain: GRAIN,
    chart: CHART,
    metric: { values: ['count', 'sum'], defaultValue: 'count' },
    compare: COMPARE,
  },
};
export const CONTRIBUTION_URL: MsMetricUrlSchema = {
  enums: { metric: { values: ['revenue', 'orders'], defaultValue: 'revenue' }, compare: COMPARE },
};
export const COMPARE_URL: MsMetricUrlSchema = { enums: { compare: COMPARE } };
// Когорты — только режим клетки (mode); окна нет (вся история), поэтому ни period, ни compare.
export const COHORTS_URL: MsMetricUrlSchema = {
  enums: { mode: { values: [...MS_COHORT_MODES], defaultValue: 'retention' } },
};
export const RFM_URL: MsMetricUrlSchema = {
  enums: {
    // 'none' = сегмент не выбран (дефолт — из URL убирается); остальные ключи — канон RFM_SEGMENTS.
    segment: {
      values: ['none', 'champions', 'loyal', 'potential', 'new', 'at_risk', 'hibernating'],
      defaultValue: 'none',
    },
    compare: COMPARE,
  },
};
