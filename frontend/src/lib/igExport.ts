// Instagram CONTENT export — WIDE, one row per publication, exactly the posts the caller passes (the
// desktop table's current post-filter/sort row set, or the mobile list's loaded posts). This helper
// only projects to columns; windowing/filtering/sorting is the caller's job. Existing IG live content
// is limited to the loaded results — this is not a full historical archive.
import { downloadCsv, type CsvRow } from '@/lib/csv';
import type { IgPost } from '@/api/schemas';
import { igEr, igInteractions } from '@/lib/igContentFilters';

const metricCell = (value: number | null | undefined): number | '' =>
  value == null || !Number.isFinite(value) ? '' : value;

const round2 = (value: number | null): number | '' =>
  value == null ? '' : Math.round(value * 100) / 100;

/** Project IG posts to wide content rows (input order preserved = caller's current sort). */
export function igContentRows(posts: IgPost[]): CsvRow[] {
  return posts.map((p) => ({
    date: p.timestamp ?? '',
    type: p.media_type ?? '',
    reach: metricCell(p.reach),
    views: metricCell(p.views),
    interactions: metricCell(igInteractions(p)),
    likes: metricCell(p.like_count),
    comments: metricCell(p.comments_count),
    saved: metricCell(p.saved),
    shares: metricCell(p.shares),
    er_pct: round2(igEr(p)),
    caption: (p.caption ?? '').replace(/\s+/g, ' ').trim(),
    permalink: p.permalink ?? '',
  }));
}

/** Download the given posts as a content CSV. `filename` defaults to the pre-redesign mobile name so
    existing IG mobile export behaviour is preserved; desktop passes a windowed, source-scoped name. */
export function exportIgPosts(posts: IgPost[], filename = 'instagram-posts.csv') {
  downloadCsv(filename, igContentRows(posts));
}
