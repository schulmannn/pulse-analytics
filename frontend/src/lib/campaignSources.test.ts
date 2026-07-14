import { describe, expect, it } from 'vitest';
import { CampaignPostSchema, CampaignSummarySchema } from '@/api/schemas';
import {
  campaignSourceKey,
  campaignSourceOptions,
  filterCampaignPosts,
  parseCampaignSourceKey,
} from '@/lib/campaignSources';

describe('campaign source identity', () => {
  it('round-trips only valid exact network/channel pairs', () => {
    expect(campaignSourceKey({ network: 'ig', channelId: 7 })).toBe('ig:7');
    expect(parseCampaignSourceKey('ig:7')).toEqual({ network: 'ig', channelId: 7 });
    for (const invalid of [null, '', 'ig', 'vk:7', 'tg:0', 'tg:-1', 'tg:1.5', 'ig:1000000000']) {
      expect(parseCampaignSourceKey(invalid)).toBeNull();
    }
  });

  it('keeps TG and IG options distinct for the same channel id', () => {
    const summary = CampaignSummarySchema.parse({
      by_source: [
        { network: 'tg', channel_id: 5, username: 'brand', posts: 3 },
        { network: 'ig', channel_id: 5, username: 'brand', posts: 2 },
      ],
    });
    const options = campaignSourceOptions(summary.by_source);
    expect(options.map((option) => option.key)).toEqual(['tg:5', 'ig:5']);
    expect(options.map((option) => option.label)).toEqual(['Telegram @brand', 'Instagram @brand']);
  });

  it('filters posts by both network and channel id', () => {
    const posts = [
      CampaignPostSchema.parse({ network: 'tg', channel_id: 5, post_ref: '1' }),
      CampaignPostSchema.parse({ network: 'ig', channel_id: 5, post_ref: 'ig-1' }),
      CampaignPostSchema.parse({ network: 'ig', channel_id: 6, post_ref: 'ig-2' }),
    ];
    expect(filterCampaignPosts(posts, { network: 'ig', channelId: 5 }).map((post) => post.post_ref)).toEqual(['ig-1']);
    expect(filterCampaignPosts(posts, null)).toHaveLength(3);
  });
});
