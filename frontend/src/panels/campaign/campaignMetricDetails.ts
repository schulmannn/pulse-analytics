/**
 * Детали разборов кампании для каталога (U05): URL-схема контролов и deps запросов. Грузится лениво
 * через loadMetricDetails('multi'). Режим ряда динамики и его вид по умолчанию зависят от данных
 * кампании (есть ли посты TG/IG), поэтому дефолт в схеме — null.
 */
import type { ExplorerUrlParam, MetricDetails } from '@/lib/metricDetails';

/** Источник внутри кампании (parseCampaignSourceKey); без параметра — все источники. */
const SOURCE: ExplorerUrlParam = { defaultValue: null };
const DEPS = { explorer: ['useCampaignSummary'] } as const;

export const details: MetricDetails = {
  info: {},
  explorerSchema: {
    'campaign.timeline': {
      url: {
        source: SOURCE,
        // Режим ряда: первый доступный из tg_views / ig_reach / posts (timelineModes).
        metric: { defaultValue: null },
        chart: { values: ['line', 'bar'], defaultValue: null },
      },
      local: [],
    },
    'campaign.sources': { url: { source: SOURCE }, local: [] },
    'campaign.formats': { url: { source: SOURCE }, local: [] },
  },
  deps: {
    'campaign.timeline': DEPS,
    'campaign.sources': DEPS,
    'campaign.formats': DEPS,
  },
};
