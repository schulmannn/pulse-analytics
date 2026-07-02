import { useMemo, useState } from 'react';
import { useTgFull } from '@/api/queries';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';
import { fmt } from '@/lib/format';
import { markdownToPlainText } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { PostDetailModal } from '@/components/PostDetailModal';
import { EmptyState } from '@/components/EmptyState';
import { usePeriod } from '@/lib/period';

/**
 * Top posts (legacy "выше среднего по вовлечению" algorithm) as a hairline table. Heading-less and
 * self-contained — used both on the Posts panel and inside the unified Overview, so each caller
 * supplies its own surrounding heading. Sortable numeric columns; rows open the detail modal.
 * No fake Δ column — per-post period-delta isn't in the data; the "+% к среднему" insight lives as
 * a sub-line instead.
 */

type SortKey = 'reach' | 'likes' | 'shares' | 'er';
interface Column {
  key: SortKey;
  label: string;
  width: string;
  get: (p: NormalizedPost) => number;
  render: (p: NormalizedPost) => string;
}
const COLUMNS: Column[] = [
  { key: 'reach', label: 'Просмотры', width: 'w-20', get: (p) => p.reach, render: (p) => fmt.short(p.reach) },
  { key: 'likes', label: 'Реакции', width: 'w-16', get: (p) => p.likes, render: (p) => fmt.short(p.likes) },
  { key: 'shares', label: 'Репосты', width: 'w-16', get: (p) => p.shares, render: (p) => fmt.short(p.shares) },
  { key: 'er', label: 'ER', width: 'w-14', get: (p) => p.er ?? 0, render: (p) => (p.er != null ? `${p.er.toFixed(1)}%` : '—') },
];

// Static metric hierarchy (size+shade, not sort state): Просмотры primary → ER derived/dimmest.
// The sort affordance lives in the header (arrow + accent); the active column just gets a weight bump.
const COLUMN_TONE: Record<SortKey, string> = {
  reach: 'text-foreground',
  likes: 'text-ink2',
  shares: 'text-ink2',
  er: 'text-ink3',
};

export function TopPosts() {
  const { days, inRange } = usePeriod();
  const { data, isPending, isError } = useTgFull(days);
  const [selected, setSelected] = useState<{ post: NormalizedPost; rank: number; reason: string | null } | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('reach');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const { rows, reasonFor } = useMemo(() => {
    const posts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {}).filter((post) => inRange(post.date));
    const withEng = posts.filter((post) => post.eng > 0);
    const avg = (pick: (p: NormalizedPost) => number) =>
      withEng.length ? withEng.reduce((sum, p) => sum + pick(p), 0) / withEng.length : 0;
    const avgEng = avg((p) => p.eng);
    const avgReach = avg((p) => p.reach);
    const avgShares = avg((p) => p.shares);

    let top: NormalizedPost[] = [];
    if (withEng.length > 0) {
      const aboveAvg = withEng.filter((post) => post.eng > avgEng);
      top = (aboveAvg.length > 0 ? [...aboveAvg] : [...withEng]).sort((a, b) => b.eng - a.eng).slice(0, 6);
    }

    const reasonFor = (post: NormalizedPost): string | null => {
      const opts = [
        { label: 'вовлечённости', ratio: avgEng > 0 ? post.eng / avgEng : 0 },
        { label: 'охвату', ratio: avgReach > 0 ? post.reach / avgReach : 0 },
        { label: 'репостам', ratio: avgShares > 0 && post.shares > 0 ? post.shares / avgShares : 0 },
      ];
      const best = opts.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      const pct = Math.round((best.ratio - 1) * 100);
      // Badge only for real outliers (≥2× the average) — a top list where every row is
      // "выше среднего" is tautological, so a mild +N% on all six rows is just noise.
      return pct >= 100 ? `+${pct}% к среднему по ${best.label}` : null;
    };

    return { rows: top, reasonFor };
  }, [data, inRange]);

  if (isPending) return <TopPostsSkeleton />;
  if (isError) return null;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Недостаточно данных для топа постов."
        reason="Нужно больше постов с вовлечением, чтобы выделить лучшие."
        action={{ to: '/analytics', label: 'Открыть аналитику' }}
      />
    );
  }

  const col = COLUMNS.find((c) => c.key === sortKey)!;
  const sorted = [...rows].sort((a, b) => (sortDir === 'desc' ? col.get(b) - col.get(a) : col.get(a) - col.get(b)));

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <div className="min-w-[560px]">
          {/* header */}
          <div className="flex items-center gap-3 border-b border-border pb-2 text-2xs text-muted-foreground">
            <span className="w-5 shrink-0" />
            <span className="flex-1">Пост</span>
            {COLUMNS.map((c) => {
              const active = c.key === sortKey;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => toggleSort(c.key)}
                  className={cn(
                    'flex shrink-0 items-center justify-end gap-1 tabular-nums transition-colors',
                    c.width,
                    active ? 'font-medium text-primary' : 'hover:text-foreground',
                  )}
                >
                  {c.label}
                  <span aria-hidden="true" className={cn('text-2xs', !active && 'text-ink3/60')}>
                    {active ? (sortDir === 'desc' ? '↓' : '↑') : '↕'}
                  </span>
                </button>
              );
            })}
            <span className="w-5 shrink-0" />
          </div>

          {/* rows */}
          {sorted.map((post, idx) => {
            const reason = reasonFor(post);
            const title = post.caption ? markdownToPlainText(post.caption) : 'Без подписи';
            return (
              <button
                key={post.id ?? idx}
                type="button"
                onClick={() => setSelected({ post, rank: idx + 1, reason })}
                title="Открыть детали поста"
                className="group flex w-full items-center gap-3 border-b border-border py-3 text-left transition-colors hover:bg-hover-row focus-visible:bg-hover-row focus-visible:outline-none"
              >
                <span className="w-5 shrink-0 text-center text-xs tabular-nums text-ink3">{idx + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm', post.caption ? 'text-foreground' : 'italic text-muted-foreground')}>
                    {title}
                  </span>
                  {reason && (
                    <span className="mt-0.5 block truncate text-2xs text-verdant">▲ {reason}</span>
                  )}
                </span>
                {COLUMNS.map((c) => (
                  <span
                    key={c.key}
                    className={cn('shrink-0 text-right text-sm tabular-nums', c.width, COLUMN_TONE[c.key], c.key === sortKey && 'font-medium')}
                  >
                    {c.render(post)}
                  </span>
                ))}
                <span className="flex w-5 shrink-0 justify-end text-ink3 transition-colors group-hover:text-foreground">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* mobile: compact list rows (no column header, no horizontal scroll) */}
      <div className="md:hidden">
        {sorted.map((post, idx) => {
          const reason = reasonFor(post);
          const title = post.caption ? markdownToPlainText(post.caption) : 'Без подписи';
          return (
            <button
              key={post.id ?? idx}
              type="button"
              onClick={() => setSelected({ post, rank: idx + 1, reason })}
              className="group flex w-full items-center gap-3 border-b border-border py-3 text-left transition-colors hover:bg-hover-row focus-visible:bg-hover-row focus-visible:outline-none"
            >
              <span className="w-5 shrink-0 text-center text-xs tabular-nums text-ink3">{idx + 1}</span>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-sm', post.caption ? 'text-foreground' : 'italic text-muted-foreground')}>
                  {title}
                </span>
                <span className="mt-0.5 block truncate text-2xs text-ink2">
                  {fmt.short(post.reach)} просмотров · {fmt.short(post.likes)} · ER {post.er != null ? `${post.er.toFixed(1)}%` : '—'}
                </span>
              </span>
              <span className="flex w-5 shrink-0 justify-end text-ink3 transition-colors group-hover:text-foreground">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        <PostDetailModal
          post={selected.post}
          rank={selected.rank}
          reason={selected.reason}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

function TopPostsSkeleton() {
  return (
    <div className="space-y-px">
      <div className="flex items-center gap-3 border-b border-border pb-2">
        <Skeleton className="h-3 w-24" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-border py-3">
          <Skeleton className="h-3 w-5" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
