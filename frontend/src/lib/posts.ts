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

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Strip raw Telegram markdown from a caption for display. Captions arrive with literal
 * `[текст](https://…)`, `**…**`, `__…__` and `` ` `` markers that leaked verbatim into table
 * rows and modals. Conservative, display-only: keeps the human text, drops the markers/urls,
 * collapses doubled spaces. Newlines are preserved (modals show multi-line captions); single
 * `*`/`_` are left alone (snake_case, @handles, bullet-asterisks are common in real captions).
 */
export function stripTgMarkdown(text: string): string {
  if (!text) return '';
  return (
    text
      // [text](url) → text (url must be a single non-space token — same shape RichText accepts)
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1') // **bold**
      .replace(/__([^_\n]+)__/g, '$1') // __underline/emphasis__
      .replace(/`([^`\n]+)`/g, '$1') // `code`
      .replace(/\*\*/g, '') // orphan ** from broken/unclosed markup
      .replace(/[ \t]{2,}/g, ' ') // collapse doubled spaces the removals leave behind
      .trim()
  );
}

/**
 * Normalize raw TG posts into the unified shape the panel renders. Ported verbatim from
 * legacy tgPostsNormalized — keeps the same field-fallback chains and metric formulas:
 *   ERV = engagement / views,  ER = engagement / followers,  virality = forwards / views.
 */
export function normalizeTgPosts(rawPosts: TgPost[], channel: ChannelContext): NormalizedPost[] {
  const followers = finiteNumber(
    channel.memberCount ?? channel.members ?? channel.member_count ?? channel.subscribers ?? 0,
  );
  const username = channel.username ?? channel.channel_username ?? '';

  return rawPosts.map((raw) => {
    const id = raw.id ?? null;
    const reach = finiteNumber(raw.views ?? raw.view_count ?? 0);
    const likes = finiteNumber(raw.reactions ?? raw.reactions_count ?? 0);
    const comments = finiteNumber(raw.replies ?? raw.comments_count ?? 0);
    const shares = finiteNumber(raw.forwards ?? 0);
    const eng = likes + shares + comments;

    // Display caption: markdown markers stripped once here so every consumer (tables, top
    // posts, modals, insights, CSV) shows clean text. Permalinks/thumbs are separate fields —
    // hrefs are never touched by the strip.
    const caption = stripTgMarkdown(raw.text ?? raw.caption ?? '');
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
      .map((r) => ({ emoji: r.emoji ?? '', count: finiteNumber(r.count ?? 0) }))
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
      albumSize: finiteNumber(raw.album_size ?? 0),
      pinned: !!raw.pinned,
      erv,
      virality,
      er,
    };
  });
}
