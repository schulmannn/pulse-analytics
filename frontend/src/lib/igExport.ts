// Instagram CSV exports, kept out of the panels. Posts → one row per publication; daily → one
// row per day merged across the metrics that carry a real series.
import { downloadCsv, type CsvRow } from '@/lib/csv';
import type { IgPost } from '@/api/schemas';
import type { Point } from '@/lib/igMetrics';

export function exportIgPosts(posts: IgPost[]) {
  downloadCsv(
    'instagram-posts.csv',
    posts.map((p) => ({
      date: p.timestamp ?? '',
      type: p.media_type ?? '',
      reach: p.reach ?? 0,
      views: p.views ?? 0,
      likes: p.like_count ?? 0,
      comments: p.comments_count ?? 0,
      saved: p.saved ?? 0,
      shares: p.shares ?? 0,
      caption: (p.caption ?? '').replace(/\s+/g, ' ').slice(0, 200),
      permalink: p.permalink ?? '',
    })),
  );
}

export function exportIgDaily(series: Record<string, Point[]>) {
  const byDay = new Map<string, CsvRow>();
  const put = (points: Point[], key: string) =>
    points.forEach((p) => {
      if (p.day === 'total') return; // skip synthetic aggregate points
      const d = p.day.slice(0, 10);
      const row = byDay.get(d) ?? { day: d };
      row[key] = p.value;
      byDay.set(d, row);
    });
  Object.entries(series).forEach(([key, points]) => put(points, key));
  const rows = [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  downloadCsv('instagram-daily.csv', rows);
}
