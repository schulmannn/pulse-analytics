/**
 * Детали метрик СДЭКа для каталога (U05): URL-схема контролов разбора и deps запросов. Грузится
 * лениво через loadMetricDetails('cdek'). Виджетов Главной у СДЭКа пока нет, поэтому текстов ⓘ
 * здесь нет — тексты страниц живут в CdekMetricPage. Записано по текущему коду: все контролы
 * разбора — useState (SHELL-4); фильтры статусов/товаров/каналов сохраняются как фильтры
 * источника, а не в URL.
 */
import type { MetricDetails, MetricExplorerSchema } from '@/lib/metricDetails';

const SERIES: MetricExplorerSchema = {
  url: {},
  local: ['chart', 'compare', 'statuses', 'products', 'channels', 'split', 'target'],
};
const BREAKDOWN: MetricExplorerSchema = { url: {}, local: ['metric'] };
/** Каталог товаров (useCdekBreakdown) нужен ряду для списка фильтра «Товары». */
const SERIES_DEPS = { explorer: ['useCdekSeries', 'useCdekSummary', 'useCdekBreakdown'] } as const;

export const details: MetricDetails = {
  info: {},
  explorerSchema: {
    'cdek.revenue': SERIES,
    'cdek.orders': SERIES,
    'cdek.avgCheck': SERIES,
    'cdek.units': SERIES,
    'cdek.price': SERIES,
    'cdek.channels': BREAKDOWN,
    'cdek.statuses': BREAKDOWN,
    'cdek.products': BREAKDOWN,
  },
  deps: {
    'cdek.revenue': SERIES_DEPS,
    'cdek.orders': SERIES_DEPS,
    'cdek.avgCheck': SERIES_DEPS,
    'cdek.units': SERIES_DEPS,
    'cdek.price': SERIES_DEPS,
    'cdek.channels': { explorer: ['useCdekBreakdown'] },
    'cdek.statuses': { explorer: ['useCdekBreakdown'] },
    'cdek.products': { explorer: ['useCdekBreakdown'] },
  },
};
