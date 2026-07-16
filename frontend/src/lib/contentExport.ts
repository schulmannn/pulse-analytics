// Content CSV — WIDE, one row per publication, exactly the rows the desktop table currently shows
// (already source-, window-, campaign-, search-, format- and sort-filtered by the caller). This helper
// only projects that row set to columns; it never re-filters or re-windows, so the file matches the
// visible table and nothing more. Telegram is capped by the repository's single wide fetch, so this is
// «currently loaded rows», not a full historical archive.
import type { CsvRow } from '@/lib/csv';
import type { NormalizedPost } from '@/lib/posts';

const FORMAT_LABEL = (post: NormalizedPost): string =>
  post.albumSize > 1 ? 'Альбом' : post.mediaType === 'video' ? 'Видео' : post.mediaType === 'photo' ? 'Фото' : 'Текст';

const round1 = (value: number | null): number | '' => (value == null ? '' : Math.round(value * 10) / 10);

/** Project displayed Telegram posts to wide content rows (order preserved = current table sort). */
export function tgContentRows(posts: NormalizedPost[]): CsvRow[] {
  return posts.map((post) => ({
    date: post.date ?? '',
    format: FORMAT_LABEL(post),
    caption: (post.caption ?? '').replace(/\s+/g, ' ').trim(),
    views: post.reach,
    reactions: post.likes,
    reposts: post.shares,
    comments: post.comments,
    erv_pct: round1(post.erv),
    virality_pct: round1(post.virality),
    er_pct: round1(post.er),
    permalink: post.permalink ?? '',
  }));
}
