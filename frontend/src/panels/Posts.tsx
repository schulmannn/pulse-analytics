import { useState, useEffect } from 'react';
import { useTgFull, usePostStats } from '@/api/queries';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';
import { fmt, ruAxisLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { markdownToPlainText } from '@/lib/markdown';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart } from '@/components/LineChart';
import { usePeriod } from '@/lib/period';
import { Skeleton } from '@/components/ui/skeleton';
import { RichText } from '@/components/RichText';
import { ChartSection } from '@/components/ChartWidget';

type SortKey = 'reach' | 'likes' | 'shares' | 'virality' | 'erv' | 'er';
const SORT_COLUMNS: { key: SortKey; label: string; get: (p: NormalizedPost) => number }[] = [
  { key: 'reach', label: 'Просмотры', get: (p) => p.reach },
  { key: 'likes', label: 'Реакции', get: (p) => p.likes },
  { key: 'shares', label: 'Репосты', get: (p) => p.shares ?? 0 },
  { key: 'virality', label: 'Вирал.', get: (p) => p.virality ?? 0 },
  { key: 'erv', label: 'ERV', get: (p) => p.erv ?? 0 },
  { key: 'er', label: 'ER', get: (p) => p.er ?? 0 },
];

export function Posts() {
  const { days, inRange } = usePeriod();
  const { data, isPending, isError, error } = useTgFull(days);
  const [openId, setOpenId] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('reach');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  if (isPending) return <PostsSkeletons />;
  if (isError) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не удалось загрузить публикации: {error instanceof Error ? error.message : 'ошибка сервера'}
        </CardContent>
      </Card>
    );
  }

  const rawPosts = data?.posts ?? [];
  const channelContext = data?.channel ?? {};
  const posts = normalizeTgPosts(rawPosts, channelContext).filter((post) => inRange(post.date));

  if (posts.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Постов пока нет
        </CardContent>
      </Card>
    );
  }

  // Таблица — сортируемый лидерборд (по любому столбцу), топ 25
  const sortGet = SORT_COLUMNS.find((c) => c.key === sortKey)!.get;
  const tablePosts = [...posts]
    .sort((a, b) => (sortDir === 'desc' ? sortGet(b) - sortGet(a) : sortGet(a) - sortGet(b)))
    .slice(0, 25);

  // ERV/ER колонки красим ТОЛЬКО у относительных выбросов среди видимых строк (≥1.5× / ≤0.5×
  // медианы колонки) — иначе почти каждая ячейка получала цвет и колонки читались «радугой».
  const ervMedian = median(tablePosts.map((p) => p.erv).filter((v): v is number => v != null));
  const erMedian = median(tablePosts.map((p) => p.er).filter((v): v is number => v != null));

  const selectedPost = posts.find((p) => p.id === openId);

  return (
    <div className="space-y-8">
      {/* «Топ постов за период» убран: он дублировал Обзор, а сортируемый лидерборд ниже
          покрывает топ (D6.4). Таблица — виджет, как и всё остальное. */}
      <ChartSection title="Публикации · топ-25">
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
                <th className="w-12 py-3 pl-0 pr-3 text-center"></th>
                <th className="min-w-[240px] px-3 py-3">Пост</th>
                {SORT_COLUMNS.map((c) => {
                  const active = c.key === sortKey;
                  return (
                    <th key={c.key} className="px-3 py-3 text-right last:pr-0">
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
              {tablePosts.map((post, idx) => {
                const isClickable = post.id != null;
                return (
                  <tr
                    key={post.id ?? idx}
                    onClick={isClickable ? () => setOpenId(post.id) : undefined}
                    className={`group transition-colors hover:bg-hover-row ${isClickable ? 'cursor-pointer' : ''}`}
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
                      <div className="max-w-sm space-y-1 md:max-w-md lg:max-w-lg">
                        <div className="line-clamp-1 font-medium text-foreground">
                          {post.caption ? <RichText text={post.caption} /> : <span className="italic text-muted-foreground">Без подписи</span>}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{fmt.date(post.date)}</span>
                          {post.albumSize > 1 && <span>· {post.albumSize} фото</span>}
                        </div>
                      </div>
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
            </tbody>
          </table>
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
      </ChartSection>

      {openId !== null && selectedPost && <PostModal post={selectedPost} onClose={() => setOpenId(null)} />}
    </div>
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

interface PostModalProps {
  post: NormalizedPost;
  onClose: () => void;
}

function PostModal({ post, onClose }: PostModalProps) {
  const stats = usePostStats(post.id);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const graphX = stats.data?.views_graph?.x ?? [];
  const graphValues = stats.data?.views_graph?.series?.[0]?.values ?? [];
  const hasGraphData = (stats.data?.available ?? false) && graphValues.length > 1;

  const chartTitles = graphX.map((ts, i) => {
    const val = graphValues[i];
    const dateStr = new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit' });
    return `${dateStr}: ${fmt.num(val ?? 0)}`;
  });

  const chartLabels = (() => {
    if (graphX.length === 0) return [];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const formatLabel = (ts: number) => {
      const d = new Date(ts);
      const mon = months[d.getMonth()] ?? '';
      const hh = String(d.getHours()).padStart(2, '0');
      // ruAxisLabel: «24 Jun 21:00» → «24 июн 21:00» — axis labels must be Russian in the RU UI.
      return ruAxisLabel(`${d.getDate()} ${mon} ${hh}:00`);
    };
    const first = graphX[0];
    const mid = graphX[Math.floor(graphX.length / 2)];
    const last = graphX[graphX.length - 1];
    return [first ? formatLabel(first) : '', mid ? formatLabel(mid) : '', last ? formatLabel(last) : ''];
  })();

  const reactionsList = stats.data?.reactions ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <Card
        className="relative max-h-[85vh] w-full max-w-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Закрыть"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <CardHeader className="pr-12">
          <CardTitle className="text-base font-medium leading-snug text-foreground">
            {post.caption ? <RichText text={post.caption} /> : <span className="italic text-muted-foreground">Без подписи</span>}
          </CardTitle>
          <div className="pt-1.5 text-xs tabular-nums text-muted-foreground">
            {fmt.short(post.reach)} просм · {fmt.short(post.likes)} реакц · {fmt.short(post.shares)} реп · {fmt.date(post.date)}
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {post.permalink && (
            <a
              href={post.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            >
              Открыть публикацию в Telegram
            </a>
          )}

          <div className="border-t border-border pt-4">
            {stats.isPending ? (
              <div className="space-y-4 py-4">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-40 w-full" />
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <Skeleton key={index} className="h-9 w-full" />
                  ))}
                </div>
              </div>
            ) : hasGraphData ? (
              <div className="space-y-6">
                <div>
                  <h4 className="mb-3 text-xs font-medium tracking-wider text-muted-foreground">
                    Динамика набора просмотров
                  </h4>
                  <LineChart values={graphValues} titles={chartTitles} labels={chartLabels} />
                </div>

                {reactionsList.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium tracking-wider text-muted-foreground">Реакции</h4>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {reactionsList.map((react, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between rounded border border-border bg-background p-2 text-xs font-medium"
                        >
                          <span className="text-sm">{react.label}</span>
                          <span className="font-medium tabular-nums text-muted-foreground">{fmt.num(react.value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Детальная статистика по этому посту недоступна.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
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
