import type { TgPost } from '@/api/schemas';

export interface NormalizedPost {
  id: number | null;
  caption: string;
  date: string | null;
  thumb: string | null;
  permalink: string | null;
  mediaType: string | null;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  eng: number;
  reactionsDetail: { emoji: string; count: number }[];
  hashtags: string[];
  albumSize: number;
  pinned: boolean;
  erv: number | null;
  virality: number | null;
  er: number | null;
}

interface ChannelContext {
  username?: string | null;
  channel_username?: string | null;
  memberCount?: number | null;
  members?: number | null;
  member_count?: number | null;
  subscribers?: number | null;
}

/**
 * Normalize raw TG posts into the unified shape the panel renders. Ported verbatim from
 * legacy tgPostsNormalized — keeps the same field-fallback chains and metric formulas:
 *   ERV = engagement / views,  ER = engagement / followers,  virality = forwards / views.
 */
export function normalizeTgPosts(rawPosts: TgPost[], channel: ChannelContext): NormalizedPost[] {
  const followers = Number(
    channel.memberCount ?? channel.members ?? channel.member_count ?? channel.subscribers ?? 0,
  );
  const username = channel.username ?? channel.channel_username ?? '';

  return rawPosts.map((raw) => {
    const id = raw.id ?? null;
    const reach = Number(raw.views ?? raw.view_count ?? 0);
    const likes = Number(raw.reactions ?? raw.reactions_count ?? 0);
    const comments = Number(raw.replies ?? raw.comments_count ?? 0);
    const shares = Number(raw.forwards ?? 0);
    const eng = likes + shares + comments;

    const caption = raw.text ?? raw.caption ?? '';
    const mediaType = raw.media_type ?? null;

    let thumb: string | null;
    if ((mediaType === 'photo' || mediaType === 'video') && id != null) {
      thumb = `/api/tg/mtproto/thumb/${id}`;
    } else {
      thumb = raw.thumb ?? null;
    }

    const permalink = username && id ? `https://t.me/${username}/${id}` : null;

    const erv = reach > 0 ? (eng / reach) * 100 : null;
    const virality = reach > 0 ? (shares / reach) * 100 : null;
    const er = followers > 0 ? (eng / followers) * 100 : null;

    const reactionsDetail = (raw.reactions_detail ?? [])
      .map((r) => ({ emoji: r.emoji ?? '', count: Number(r.count ?? 0) }))
      .filter((r) => r.emoji !== '');

    return {
      id,
      caption,
      date: raw.date ?? null,
      thumb,
      permalink,
      mediaType,
      reach,
      likes,
      comments,
      shares,
      eng,
      reactionsDetail,
      hashtags: raw.hashtags ?? [],
      albumSize: Number(raw.album_size ?? 0),
      pinned: !!raw.pinned,
      erv,
      virality,
      er,
    };
  });
}
