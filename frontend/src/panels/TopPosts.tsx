import { useMemo, useState } from 'react';
import { useChannels, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';
import { compareToMedian, medianDeltaLabel, periodMedian } from '@/lib/postMedian';
import { fmt } from '@/lib/format';
import { markdownToPlainText } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { PostDetailModal } from '@/components/PostDetailModal';
import { EmptyState } from '@/components/EmptyState';
import { useWidgetPeriod } from '@/lib/period';
import { Icon } from '@/components/nav-icons';

/**
 * Top posts (legacy "выше среднего по вовлечению" algorithm). Heading-less and self-contained —
 * each caller supplies its own surrounding heading. Two desktop presentations, one shared ranking:
 *  - `variant="table"` (default): the sortable hairline table (Контент panel + reports/PDF).
 *  - `variant="cards"`: an IG-parity 3-column cover grid (TG Обзор + the legacy Home top-posts widget).
 * The mobile branch is a compact list in BOTH variants (unchanged). Rows/cards open the detail modal.
 * No fake Δ column — per-post period-delta isn't in the data; the "+% к среднему" insight lives as
 * a sub-line / passes to the modal instead.
 */

/** How many cover cards the desktop `cards` variant shows — one 3-up row (IG Обзор parity). */
const CARDS_LIMIT = 3;

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

import { ErrorState } from '@/components/ErrorState';

export function TopPosts({ variant = 'table' }: { variant?: 'table' | 'cards' } = {}) {
  // Resolved feed/Home window. Wide fetch (limit 100), filtered client-side by inRange.
  const { inRange } = useWidgetPeriod();
  const { data, isPending, isError, refetch } = useTgFull(0);
  // Thumbnail safety: the /api/tg/mtproto/thumb proxy is only trustworthy for the ONE central
  // channel (message ids resolve through it), so only vouch for proxy covers when the selected
  // source is central. Any other source gets a neutral placeholder instead of possibly-wrong media.
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const proxyThumbs =
    channelsData?.channels.find((c) => c.id === channelId)?.source === 'central';
  const [selected, setSelected] = useState<{ post: NormalizedPost; rank: number; reason: string | null } | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('reach');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const { rows, reasonFor, reachMedian } = useMemo(() => {
    const posts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {}, { proxyThumbs }).filter((post) => inRange(post.date));
    const withEng = posts.filter((post) => post.eng > 0);
    // Period median of the primary metric (reach) across EVERY post in the window — the honest
    // "typical post" baseline each top row is measured against. Median (not mean) so a single viral
    // post can't inflate the bar every other post is judged by. Withheld below MEDIAN_MIN_SAMPLE.
    const reachMedian = periodMedian(posts.map((post) => post.reach));
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

    return { rows: top, reasonFor, reachMedian };
  }, [data, inRange, proxyThumbs]);

  // Explicit "+42% к медиане" label on the primary metric (Task 6): colour is never the only
  // explanation. Falls back to the outlier reason when the period is too small for a median.
  const medianLabelFor = (post: NormalizedPost): string | null => {
    const cmp = compareToMedian(post.reach, reachMedian);
    if (cmp && cmp.dir === 'above') return medianDeltaLabel(cmp);
    return reasonFor(post);
  };

  if (isPending) return <TopPostsSkeleton variant={variant} />;
  // Честная ошибка вместо молчаливого исчезновения (дизайн-аудит).
  if (isError) return <ErrorState title="Не удалось загрузить публикации" onRetry={() => refetch()} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Недостаточно данных для топа постов."
        reason="Нужно больше постов с вовлечением, чтобы выделить лучшие."
        action={{ to: '/posts', label: 'Открыть контент' }}
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

  // Cards variant reuses the SAME candidate/ranking rows, presented in reach order (no sort UI —
  // IG Обзор parity), capped to one 3-up row.
  const cardPosts = [...rows].sort((a, b) => b.reach - a.reach).slice(0, CARDS_LIMIT);

  return (
    <>
      {variant === 'cards' && (
        <div
          data-testid="tg-top-posts-cards"
          className="hidden md:grid md:gap-6"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))' }}
        >
          {cardPosts.map((post, idx) => (
            <TopPostCard
              key={`${channelId ?? 'none'}:${post.id ?? idx}`}
              post={post}
              rank={idx + 1}
              onOpen={() => setSelected({ post, rank: idx + 1, reason: medianLabelFor(post) })}
            />
          ))}
        </div>
      )}

      <div
        data-testid="tg-top-posts-table"
        className={cn('overflow-x-auto', variant === 'cards' ? 'hidden' : 'hidden md:block')}
      >
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
                  aria-pressed={active}
                  aria-label={`Сортировка: ${c.label}${active ? (sortDir === 'desc' ? ', по убыванию' : ', по возрастанию') : ''}`}
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
            const reason = medianLabelFor(post);
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
                    <span className="mt-0.5 block truncate text-2xs text-muted-foreground">▲ {reason}</span>
                  )}
                </span>
                {COLUMNS.map((c) => (
                  <span
                    key={c.key}
                    className={cn('shrink-0 text-right text-sm tabular-nums', c.width, COLUMN_TONE[c.key], c.key === sortKey && 'font-medium')}
                  >
                    <span className="sr-only">{c.label}: </span>
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

/** Russian media-type label for the card's hairline header (albums win over the raw media type). */
function tgMediaLabel(post: NormalizedPost): string {
  if (post.albumSize > 1) return 'Альбом';
  switch (post.mediaType) {
    case 'video':
      return 'Видео';
    case 'photo':
      return 'Фото';
    case 'document':
      return 'Файл';
    default:
      return 'Пост';
  }
}

/** Neutral stroke glyph for cards without a usable cover — play for video, photo frame otherwise. */
function TgMediaPlaceholderGlyph({ video }: { video: boolean }) {
  return <Icon name={video ? 'playCircle' : 'image'} className="h-7 w-7" />;
}

/** One metric cell in the card footer — label over value, centred. */
function CardStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-2xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium tabular-nums text-foreground">{value}</div>
    </div>
  );
}

/**
 * IG-parity cover card for a single top post (desktop `cards` variant). Unframed (it lives inside a
 * ChartSection): a hairline top border, rank + media type header, a stable 4:5 cover with a neutral
 * placeholder when the cover is absent OR fails to load, a 3-line caption clamp, and the four TG
 * metrics. The whole card is a button that opens the detail modal.
 */
function TopPostCard({ post, rank, onOpen }: { post: NormalizedPost; rank: number; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const isVideo = post.mediaType === 'video';
  const cover = !failed ? post.thumb : null;
  const title = post.caption ? markdownToPlainText(post.caption) : '';
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Открыть детали поста"
      data-testid="tg-top-post-card"
      className="group flex flex-col border-t border-border pt-3 text-left focus-visible:outline-none"
    >
      <div className="mb-2 flex items-center justify-between text-2xs font-medium tracking-wide">
        <span className="tabular-nums text-ink3">#{rank}</span>
        <span className="text-muted-foreground">{tgMediaLabel(post)}</span>
      </div>
      {/* Stable 4:5 cover keeps the 3-up row aligned; absent/failed media falls back to a glyph. */}
      <div
        data-testid="tg-top-post-media"
        className="flex aspect-[4/5] w-full items-center justify-center overflow-hidden rounded bg-muted text-muted-foreground"
      >
        {cover ? (
          <img
            src={cover}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
          />
        ) : (
          <TgMediaPlaceholderGlyph video={isVideo} />
        )}
      </div>
      <p className={cn('mt-3 line-clamp-3 flex-1 text-sm leading-relaxed', title ? 'text-foreground' : 'italic text-muted-foreground')}>
        {title || 'Без подписи'}
      </p>
      <div className="mt-3 grid grid-cols-4 gap-1 border-t border-border pt-3 text-center">
        <CardStat label="Просм." value={fmt.short(post.reach)} />
        <CardStat label="Реакции" value={fmt.short(post.likes)} />
        <CardStat label="Коммент." value={fmt.short(post.comments)} />
        <CardStat label="Репосты" value={fmt.short(post.shares)} />
      </div>
    </button>
  );
}

function TopPostsSkeleton({ variant = 'table' }: { variant?: 'table' | 'cards' } = {}) {
  return (
    <>
      {variant === 'cards' && (
        <div
          className="hidden md:grid md:gap-6"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))' }}
        >
          {Array.from({ length: CARDS_LIMIT }).map((_, i) => (
            <div key={i} className="flex flex-col border-t border-border pt-3">
              <div className="mb-2 flex items-center justify-between">
                <Skeleton className="h-3 w-6" />
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="aspect-[4/5] w-full rounded" />
              <Skeleton className="mt-3 h-4 w-full" />
              <Skeleton className="mt-2 h-4 w-3/4" />
              <Skeleton className="mt-3 h-10 w-full" />
            </div>
          ))}
        </div>
      )}
      <div className={cn('space-y-px', variant === 'cards' && 'md:hidden')}>
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
    </>
  );
}
