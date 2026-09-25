/**
 * Детали разборов упоминаний для каталога (U05). Грузятся лениво вместе с деталями Telegram
 * (loadMetricDetails('tg')). Тексты страниц пока живут в MentionsMetricPage.
 */
import type { ExplorerUrlParam, MetricDetails } from '@/lib/metricDetails';

/** Канал-источник упоминаний: у ленты — фильтр, у рейтинга — только цель ссылки «назад». */
const SOURCE: ExplorerUrlParam = { defaultValue: null };

export const details: MetricDetails = {
  info: {},
  explorerSchema: {
    'mentions.timeline': { url: { source: SOURCE }, local: ['chart', 'compare'] },
    'mentions.sources': { url: { source: SOURCE }, local: [] },
  },
  deps: {
    'mentions.timeline': { explorer: ['useMentionsArchive'] },
    'mentions.sources': { explorer: ['useMentionsArchive'] },
  },
};
