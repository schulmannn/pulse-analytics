import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_METRIC_KEYS,
  campaignBackPath,
  campaignMetricPath,
  isCampaignMetricKey,
} from '@/panels/campaign/campaignMetricKeys';

describe('campaign full-screen metric routes', () => {
  it('registers only the three campaign visualizations', () => {
    expect(CAMPAIGN_METRIC_KEYS).toEqual(['timeline', 'sources', 'formats']);
    expect(new Set(CAMPAIGN_METRIC_KEYS).size).toBe(CAMPAIGN_METRIC_KEYS.length);
    for (const key of CAMPAIGN_METRIC_KEYS) expect(isCampaignMetricKey(key)).toBe(true);
    for (const key of ['posts', 'extremes', 'mentions-timeline', undefined]) {
      expect(isCampaignMetricKey(key)).toBe(false);
    }
  });

  it('preserves campaign scope/table state and seeds the requested timeline mode', () => {
    const current = new URLSearchParams('source=ig%3A2&q=reels&sort=result&chart=bar');
    expect(campaignMetricPath(7, 'timeline', current, 'ig_reach')).toBe(
      '/campaigns/7/metrics/timeline?source=ig%3A2&q=reels&sort=result&metric=ig_reach',
    );
    expect(campaignMetricPath(7, 'formats', current)).toBe(
      '/campaigns/7/metrics/formats?source=ig%3A2&q=reels&sort=result',
    );
  });

  it('removes explorer-only chart state on the way back', () => {
    expect(campaignBackPath(7, new URLSearchParams('source=tg%3A1&metric=posts&chart=line'))).toBe(
      '/campaigns/7?source=tg%3A1&metric=posts',
    );
  });
});
