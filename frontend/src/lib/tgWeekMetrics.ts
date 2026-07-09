import type { ChannelsResponse, HistoryData, TgFull } from '@/api/schemas';
import { subscriberChange, subscriberDelta, type MetricDelta } from '@/lib/delta';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface TgWeekRaw {
  full: TgFull | undefined;
  history: HistoryData | undefined;
  channelsData: ChannelsResponse | undefined;
  channelId: number | null;
  now?: number;
}

export interface TgWeekNarrativePost {
  title: string;
  views: number;
  reactions: number;
  forwards: number;
  replies: number;
  erv: number;
}

export interface TgWeekSubscriber {
  subsNow: number | null;
  subsD7: number | null;
  trend: MetricDelta | null;
}

export interface TgWeekMetrics {
  allPosts: NormalizedPost[];
  weekPosts: NormalizedPost[];
  monthPosts: NormalizedPost[];
  narrativePosts: TgWeekNarrativePost[];
  avgErv: number | null;
  subscriber: TgWeekSubscriber;
}

const postErv = (post: NormalizedPost): number => (post.reach > 0 ? (post.eng / post.reach) * 100 : 0);

const inTrailingWindow = (date: string | null | undefined, now: number, spanMs: number): boolean => {
  if (!date) return false;
  const t = Date.parse(date);
  return Number.isFinite(t) && now - t <= spanMs;
};

function latestSubscriberLevel(history: HistoryData | undefined, now: number): number | null {
  const latest = (history?.rows ?? [])
    .filter((row) => row.subscribers != null)
    .map((row) => ({ t: Date.parse(row.day), subscribers: Number(row.subscribers) }))
    .filter((point) => Number.isFinite(point.t) && point.t <= now && Number.isFinite(point.subscribers))
    .sort((a, b) => a.t - b.t)
    .at(-1);
  return latest?.subscribers ?? null;
}

export function tgWeekMetrics(raw: TgWeekRaw): TgWeekMetrics {
  const { full, history, channelsData, channelId } = raw;
  const now = raw.now ?? Date.now();
  const allPosts = normalizeTgPosts(full?.posts ?? [], full?.channel ?? {});
  const weekPosts = allPosts.filter((post) => inTrailingWindow(post.date, now, WEEK_MS));
  const monthPosts = allPosts.filter((post) => inTrailingWindow(post.date, now, 4 * WEEK_MS));
  const ervBase = monthPosts.filter((post) => post.reach > 0);
  const avgErv = ervBase.length >= 3 ? ervBase.reduce((acc, post) => acc + postErv(post), 0) / ervBase.length : null;
  const current = channelsData?.channels.find((channel) => channel.id === channelId);
  const liveMembers = full?.channel?.memberCount ?? full?.channel?.members ?? null;
  const subsNow = current?.memberCount ?? liveMembers ?? latestSubscriberLevel(history, now);

  return {
    allPosts,
    weekPosts,
    monthPosts,
    narrativePosts: weekPosts.map((post) => ({
      title: (post.caption || 'Пост без текста').slice(0, 80),
      views: post.reach,
      reactions: post.likes,
      forwards: post.shares,
      replies: post.comments,
      erv: postErv(post),
    })),
    avgErv,
    subscriber: {
      subsNow,
      subsD7: subscriberChange(history?.rows ?? [], 7, now),
      trend: subscriberDelta(history?.rows ?? [], 7, now),
    },
  };
}
