/**
 * Детали метрик Rusender для каталога (U05): URL-схема контролов разбора и deps запросов.
 * Грузится лениво через loadMetricDetails('rusender'). Виджетов Главной у Rusender пока нет —
 * текстов ⓘ здесь нет, тексты страницы живут в RusenderMetricPage. Тип графика — useState.
 */
import type { MetricDetails, MetricExplorerSchema } from '@/lib/metricDetails';

const SERIES: MetricExplorerSchema = { url: {}, local: ['chart'] };
const DEPS = { explorer: ['useRusenderSummary'] } as const;

export const details: MetricDetails = {
  info: {},
  explorerSchema: {
    'rusender.opens': SERIES,
    'rusender.clicks': SERIES,
    'rusender.contacts': SERIES,
    'rusender.unsubscribed': SERIES,
  },
  deps: {
    'rusender.opens': DEPS,
    'rusender.clicks': DEPS,
    'rusender.contacts': DEPS,
    'rusender.unsubscribed': DEPS,
  },
};
