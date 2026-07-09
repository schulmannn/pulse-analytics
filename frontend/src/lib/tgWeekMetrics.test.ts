import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelsResponse, HistoryData, TgFull } from '@/api/schemas';
import { subscriberChange } from '@/lib/delta';
import { deriveKpis } from '@/lib/kpiDerive';
import { tgWeekMetrics } from '@/lib/tgWeekMetrics';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-15T12:00:00.000Z');

const dayAgo = (ago: number) => new Date(NOW - ago * DAY_MS).toISOString().slice(0, 10);
const postDateAgo = (ago: number) => `${dayAgo(ago)}T12:00:00.000Z`;
const inLastWeek = (date: string | null | undefined) => {
  const t = Date.parse(date ?? '');
  return Number.isFinite(t) && t >= NOW - 7 * DAY_MS && t <= NOW;
};

function fixture() {
  const history: HistoryData = {
    rows: Array.from({ length: 14 }, (_, i) => ({
      day: dayAgo(13 - i),
      subscribers: 1000 + i * 3,
      views: 100 + i,
      reactions: 10 + i,
      forwards: 2 + i,
    })),
  };
  const full: TgFull = {
    mtproto_available: true,
    channel: { memberCount: 1200, username: 'demo' },
    posts: [
      { id: 1, date: postDateAgo(1), views: 100, reactions: 10, forwards: 2, replies: 1, text: 'Fresh one' },
      { id: 2, date: postDateAgo(3), view_count: 200, reactions_count: 15, forwards: 3, comments_count: 4, text: 'Fallback fields' },
      { id: 3, date: postDateAgo(6), views: 50, reactions: 5, forwards: 1, replies: 0, text: 'Still current' },
      { id: 4, date: postDateAgo(9), views: 900, reactions: 90, forwards: 9, replies: 9, text: 'Previous window' },
      { id: 5, date: postDateAgo(13), views: 700, reactions: 70, forwards: 7, replies: 7, text: 'Previous baseline' },
    ],
  };
  const channelsData: ChannelsResponse = {
    channels: [{ id: 7, memberCount: 1300, title: 'Demo' }],
    selected: 7,
  };
  return { full, history, channelsData };
}

describe('tgWeekMetrics convergence with deriveKpis', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the same subscriber delta definition as deriveKpis', () => {
    const { full, history, channelsData } = fixture();
    const metrics = tgWeekMetrics({ full, history, channelsData, channelId: 7, now: NOW });
    const kpis = deriveKpis(full, history, channelsData, 7, 7, null, inLastWeek);

    expect(metrics.subscriber.subsNow).toBe(kpis.displayMembers);
    expect(metrics.subscriber.subsD7).toBe(subscriberChange(kpis.historyRows, 7, NOW));
    expect(metrics.subscriber.trend).toEqual(kpis.subscriberTrend);
  });

  it('maps normalized post fields for the narrative input (reach→views, likes→reactions, comments→replies)', () => {
    const { full, history, channelsData } = fixture();
    const metrics = tgWeekMetrics({ full, history, channelsData, channelId: 7, now: NOW });

    expect(metrics.narrativePosts.map((post) => ({
      views: post.views,
      reactions: post.reactions,
      forwards: post.forwards,
      replies: post.replies,
      erv: post.erv,
    }))).toEqual([
      { views: 100, reactions: 10, forwards: 2, replies: 1, erv: 13 },
      { views: 200, reactions: 15, forwards: 3, replies: 4, erv: 11 },
      { views: 50, reactions: 5, forwards: 1, replies: 0, erv: 12 },
    ]);
  });
});
