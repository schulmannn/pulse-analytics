import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { useTgFull } from '@/api/queries';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { markdownToPlainText } from '@/lib/markdown';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState } from '@/components/ErrorState';
import { useWidgetPeriod } from '@/lib/period';
import { Skeleton } from '@/components/ui/skeleton';
import { RichText } from '@/components/RichText';
import { ChartSection } from '@/components/ChartWidget';
import { PostDetailModal } from '@/components/PostDetailModal';

type SortKey = 'reach' | 'likes' | 'shares' | 'virality' | 'erv' | 'er';
const SORT_COLUMNS: { key: SortKey; label: string; get: (p: NormalizedPost) => number }[] = [
  { key: 'reach', label: 'Просмотры', get: (p) => p.reach },
  { key: 'likes', label: 'Реакции', get: (p) => p.likes },
  { key: 'shares', label: 'Репосты', get: (p) => p.shares ?? 0 },
  { key: 'virality', label: 'Вирал.', get: (p) => p.virality ?? 0 },
  { key: 'erv', label: 'ERV', get: (p) => p.erv ?? 0 },
  { key: 'er', label: 'ER', get: (p) => p.er ?? 0 },
];

const INITIAL_VISIBLE_ROWS = 25;
const LOAD_MORE_ROWS = 25;
const DESKTOP_ROW_HEIGHT = 64;
const DESKTOP_OVERSCAN_ROWS = 6;
const DESKTOP_SCROLL_THRESHOLD = DESKTOP_ROW_HEIGHT * 2;

export function Posts() {
  // ONE wide fetch (limit 0 = server cap 100); the leaderboard below windows it to its own
  // widget period. The fetch/skeleton/error stay here; the period-driven view is the child.
  const { data, isPending, isError, error } = useTgFull(0);

  if (isPending) return <PostsSkeletons />;
  if (isError) {
    return <ErrorState title="Не удалось загрузить публикации" reason={error instanceof Error ? error.message : 'ошибка сервера'} />;
  }

  const allPosts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {});
  if (allPosts.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Постов пока нет
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {/* «Топ постов за период» убран: он дублировал Обзор, а сортируемый лидерборд ниже
          покрывает топ (D6.4). Таблица — виджет. full = content-height: 25 строк должны РАСТИ,
          не скроллиться в фикс-тайле. periodControl = свои пилюли периода; окно применяется к
          лидерборду внутри (PostsLeaderboard читает useWidgetPeriod ЭТОЙ карточки). */}
      <ChartSection title="Публикации · таблица" defaultSize="full" periodControl>
        <PostsLeaderboard allPosts={allPosts} />
      </ChartSection>
    </div>
  );
}

/**
 * The sortable posts leaderboard, windowed by the card's OWN period. Rendered as ChartSection
 * children → inside its WidgetPeriodProvider, so `useWidgetPeriod` here reads THIS card's window
 * and the header pills genuinely filter the table (the hook used to sit at the panel top, above
 * the card, so the pills couldn't reach it). Owns the sort + open-post state; the empty-state now
 * sits INSIDE the card, so a narrow window with no posts reads as «nothing in this window», not a
 * wiped panel.
 */
function PostsLeaderboard({ allPosts }: { allPosts: NormalizedPost[] }) {
  const { inRange } = useWidgetPeriod();
  const [openId, setOpenId] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('reach');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_ROWS);
  const [desktopScrollTop, setDesktopScrollTop] = useState(0);
  const [desktopViewportHeight, setDesktopViewportHeight] = useState(420);
  const desktopViewportRef = useRef<HTMLDivElement>(null);
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const posts = useMemo(() => allPosts.filter((post) => inRange(post.date)), [allPosts, inRange]);
  const sortGet = SORT_COLUMNS.find((c) => c.key === sortKey)!.get;
  const sortedPosts = useMemo(
    () => [...posts].sort((a, b) => (sortDir === 'desc' ? sortGet(b) - sortGet(a) : sortGet(a) - sortGet(b))),
    [posts, sortDir, sortGet],
  );
  const tablePosts = sortedPosts.slice(0, visibleLimit);
  const hasMoreRows = visibleLimit < sortedPosts.length;
  const loadMoreRows = useCallback(() => {
    setVisibleLimit((current) => Math.min(current + LOAD_MORE_ROWS, sortedPosts.length));
  }, [sortedPosts.length]);

  useEffect(() => {
    setVisibleLimit((current) =>
      Math.min(Math.max(current, INITIAL_VISIBLE_ROWS), Math.max(sortedPosts.length, INITIAL_VISIBLE_ROWS)),
    );
  }, [sortedPosts.length]);

  useEffect(() => {
    setDesktopScrollTop(0);
    if (desktopViewportRef.current) desktopViewportRef.current.scrollTop = 0;
  }, [sortKey, sortDir, sortedPosts.length]);

  useEffect(() => {
    const node = desktopViewportRef.current;
    if (!node) return;

    const updateHeight = () => setDesktopViewportHeight(node.clientHeight || 420);
    updateHeight();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateHeight);
      observer.observe(node);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  const handleDesktopScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const node = event.currentTarget;
      setDesktopScrollTop(node.scrollTop);
      if (hasMoreRows && node.scrollTop + node.clientHeight >= node.scrollHeight - DESKTOP_SCROLL_THRESHOLD) {
        loadMoreRows();
      }
    },
    [hasMoreRows, loadMoreRows],
  );

  const virtualStart = Math.max(0, Math.floor(desktopScrollTop / DESKTOP_ROW_HEIGHT) - DESKTOP_OVERSCAN_ROWS);
  const virtualEnd = Math.min(
    tablePosts.length,
    Math.ceil((desktopScrollTop + desktopViewportHeight) / DESKTOP_ROW_HEIGHT) + DESKTOP_OVERSCAN_ROWS,
  );
  const virtualPosts = tablePosts.slice(virtualStart, virtualEnd);
  const topSpacerHeight = virtualStart * DESKTOP_ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, (tablePosts.length - virtualEnd) * DESKTOP_ROW_HEIGHT);
  const totalColumns = SORT_COLUMNS.length + 2;

  // ERV/ER колонки красим ТОЛЬКО у относительных выбросов среди видимых строк (≥1.5× / ≤0.5×
  // медианы колонки) — иначе почти каждая ячейка получала цвет и колонки читались «радугой».
  const ervMedian = median(tablePosts.map((p) => p.erv).filter((v): v is number => v != null));
  const erMedian = median(tablePosts.map((p) => p.er).filter((v): v is number => v != null));

  const selectedPost = posts.find((p) => p.id === openId);

  if (posts.length === 0) {
    return <div className="py-8 text-center text-sm text-muted-foreground">За выбранный период публикаций нет.</div>;
  }

  return (
    <>
      <div className="hidden md:block">
        <div ref={desktopViewportRef} className="max-h-[640px] overflow-auto pr-1" onScroll={handleDesktopScroll}>
        <table aria-rowcount={sortedPosts.length} className="w-full border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
              <th className="w-12 py-3 pl-0 pr-3 text-center"></th>
              <th className="min-w-[240px] px-3 py-3">Пост</th>
              {SORT_COLUMNS.map((c) => {
                const active = c.key === sortKey;
                return (
                  <th
                    key={c.key}
                    aria-sort={active ? (sortDir === 'desc' ? 'descending' : 'ascending') : undefined}
                    className="px-3 py-3 text-right last:pr-0"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={cn('ml-auto inline-flex items-center gap-1 tabular-nums transition-colors', active ? 'text-primary' : 'hover:text-foreground')}
                    >
                      {c.label}
                      <span aria-hidden="true" className={cn('text-2xs', !active && 'text-ink3/60')}>
                        {active ? (sortDir === 'desc' ? '↓' : '↑') : '↕'}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {topSpacerHeight > 0 && (
              <tr aria-hidden="true">
                <td colSpan={totalColumns} className="p-0" style={{ height: topSpacerHeight }} />
              </tr>
            )}
            {virtualPosts.map((post, idx) => {
              const rowIndex = virtualStart + idx;
              const isClickable = post.id != null;
              return (
                <tr
                  key={post.id ?? rowIndex}
                  onClick={isClickable ? () => setOpenId(post.id) : undefined}
                  className={`group h-16 transition-colors hover:bg-hover-row ${isClickable ? 'cursor-pointer' : ''}`}
                >
                  <td className="py-3 pl-0 pr-3 text-center">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-border/40 bg-muted">
                      {post.thumb ? (
                        <img
                          loading="lazy"
                          src={post.thumb}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="text-2xs font-medium text-muted-foreground">Текст</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    {isClickable ? (
                      // A real, focusable control in the row — the tr onClick alone is mouse-only,
                      // leaving keyboard users no desktop path to the post details. Plain-text
                      // caption (like the mobile row): RichText renders <a> links, which must not
                      // nest inside a button. Same destination as the row click, so bubbling is a
                      // harmless duplicate.
                      <button
                        type="button"
                        onClick={() => setOpenId(post.id)}
                        className="block w-full max-w-sm space-y-1 text-left md:max-w-md lg:max-w-lg"
                      >
                        {/* no `block` here: it would override line-clamp's display:-webkit-box and kill the clamp */}
                        <span className={cn('line-clamp-1 font-medium', post.caption ? 'text-foreground' : 'italic text-muted-foreground')}>
                          {post.caption ? markdownToPlainText(post.caption) : 'Без подписи'}
                        </span>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{fmt.date(post.date)}</span>
                          {post.albumSize > 1 && <span>· {post.albumSize} фото</span>}
                        </span>
                      </button>
                    ) : (
                      <div className="max-w-sm space-y-1 md:max-w-md lg:max-w-lg">
                        <div className="line-clamp-1 font-medium text-foreground">
                          {post.caption ? <RichText text={post.caption} /> : <span className="italic text-muted-foreground">Без подписи</span>}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{fmt.date(post.date)}</span>
                          {post.albumSize > 1 && <span>· {post.albumSize} фото</span>}
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right font-medium tabular-nums last:pr-0">{fmt.num(post.reach)}</td>
                  <td className="px-3 py-3 text-right font-medium tabular-nums last:pr-0 text-muted-foreground">{fmt.num(post.likes)}</td>
                  <td className="px-3 py-3 text-right font-medium tabular-nums last:pr-0 text-muted-foreground">
                    {post.shares ? fmt.num(post.shares) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-3 py-3 text-right font-medium tabular-nums last:pr-0 text-muted-foreground">
                    {post.virality != null ? `${post.virality.toFixed(1)}%` : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-3 py-3 text-right font-medium tabular-nums last:pr-0">
                    <PctTag value={post.erv} median={ervMedian} />
                  </td>
                  <td className="px-3 py-3 text-right font-medium tabular-nums last:pr-0">
                    <PctTag value={post.er} median={erMedian} />
                  </td>
                </tr>
              );
            })}
            {bottomSpacerHeight > 0 && (
              <tr aria-hidden="true">
                <td colSpan={totalColumns} className="p-0" style={{ height: bottomSpacerHeight }} />
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
      {/* mobile: card list (no horizontal scroll) — reuses the TopPosts row shape */}
      <div className="divide-y divide-border md:hidden">
        {tablePosts.map((post, idx) => {
          const isClickable = post.id != null;
          const title = post.caption ? markdownToPlainText(post.caption) : null;
          return (
            <button
              key={post.id ?? idx}
              type="button"
              onClick={isClickable ? () => setOpenId(post.id) : undefined}
              className={cn('flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-hover-row', isClickable && 'cursor-pointer')}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-border/40 bg-muted">
                {post.thumb ? (
                  <img loading="lazy" src={post.thumb} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-2xs font-medium text-muted-foreground">Текст</span>
                )}
              </div>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-sm', title ? 'text-foreground' : 'italic text-muted-foreground')}>
                  {title ?? 'Без подписи'}
                </span>
                <span className="mt-0.5 block truncate text-2xs text-ink2">
                  {fmt.num(post.reach)} просмотров · {fmt.num(post.likes)} · ER {post.er != null ? `${post.er.toFixed(1)}%` : '—'}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>
          Показано {tablePosts.length} из {sortedPosts.length}
        </span>
        {hasMoreRows ? (
          <button
            type="button"
            onClick={loadMoreRows}
            className="self-start rounded border border-border px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-muted sm:self-auto"
          >
            Показать ещё {Math.min(LOAD_MORE_ROWS, sortedPosts.length - tablePosts.length)}
          </button>
        ) : (
          <span>Все строки загружены</span>
        )}
      </div>

      {/* Общая модалка поста (D6.2): без №-бейджа — порядок таблицы зависит от текущей сортировки. */}
      {openId !== null && selectedPost && (
        <PostDetailModal post={selectedPost} reason={null} onClose={() => setOpenId(null)} />
      )}
    </>
  );
}

/** Median of a numeric list; null for an empty list. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * ERV/ER cell — neutral by default; colour marks only relative outliers within the visible
 * rows: verdant at ≥1.5× the column median, ember at ≤0.5×. (Absolute thresholds painted
 * nearly every row before.) DeltaPill semantics elsewhere are untouched.
 */
function PctTag({ value, median }: { value: number | null; median: number | null }) {
  if (value == null) return <span className="text-muted-foreground/40">—</span>;
  let colorClass = 'text-ink2';
  if (median != null && median > 0) {
    if (value >= median * 1.5) colorClass = 'font-medium text-verdant';
    else if (value <= median * 0.5) colorClass = 'font-medium text-ember';
  }
  return <span className={colorClass}>{value.toFixed(1)}%</span>;
}

function PostsSkeletons() {
  // Mirrors the loaded layout exactly — ONE «Публикации» widget card with title + table rows
  // (the old top-posts grid ghost promised a section that no longer exists → layout jump).
  return (
    <div className="space-y-8">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <Skeleton className="h-3 w-40" />
        <div className="mt-5 space-y-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-10 w-10" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/4" />
              </div>
              <Skeleton className="h-4 w-14" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
