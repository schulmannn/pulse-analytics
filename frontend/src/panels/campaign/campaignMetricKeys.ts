import type { TimelineMode } from '@/lib/campaignPageModel';

export const CAMPAIGN_METRIC_KEYS = [
  'timeline',
  'sources',
  'formats',
] as const;

export type CampaignMetricKey = (typeof CAMPAIGN_METRIC_KEYS)[number];

export function isCampaignMetricKey(key: string | undefined): key is CampaignMetricKey {
  return key != null && (CAMPAIGN_METRIC_KEYS as readonly string[]).includes(key);
}

/** Dedicated chart route while preserving the campaign page's source/table state. */
export function campaignMetricPath(
  campaignId: number,
  metricKey: CampaignMetricKey,
  current: URLSearchParams,
  timelineMode?: TimelineMode,
): string {
  const params = new URLSearchParams(current);
  params.delete('chart');
  if (metricKey === 'timeline' && timelineMode) params.set('metric', timelineMode);
  const query = params.toString();
  return `/campaigns/${campaignId}/metrics/${metricKey}${query ? `?${query}` : ''}`;
}

/** Return target for a metric page; explorer-only presentation state stays behind. */
export function campaignBackPath(campaignId: number, current: URLSearchParams): string {
  const params = new URLSearchParams(current);
  params.delete('chart');
  const query = params.toString();
  return `/campaigns/${campaignId}${query ? `?${query}` : ''}`;
}
