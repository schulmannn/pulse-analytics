import { useState, useEffect } from 'react';
import { useTgFull, usePostStats } from '@/api/queries';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';
import { fmt } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart } from '@/components/LineChart';
import { usePeriod } from '@/lib/period';
import { Skeleton } from '@/components/ui/skeleton';
import { RichText } from '@/components/RichText';
import { TopPosts } from '@/panels/TopPosts';

export function Posts() {
  const { days, inRange } = usePeriod();
  const { data, isLoading, isError, error } = useTgFull(days);
  const [openId, setOpenId] = useState<number | null>(null);

  if (isLoading) return <PostsSkeletons />;
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

  // Таблица — по охвату, топ 25
  const tablePosts = [...posts].sort((a, b) => b.reach - a.reach).slice(0, 25);

  const selectedPost = posts.find((p) => p.id === openId);

  return (
    <div className="space-y-8">
      {/* Топ постов (общий компонент, переиспользуется в Обзоре) */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium tracking-wide text-muted-foreground">
          Топ постов за период
        </h3>
        <TopPosts />
      </div>

      {/* Таблица публикаций */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium tracking-wide text-muted-foreground">
          Последние публикации (Топ-25 по охвату)
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
                <th className="w-12 p-4 text-center"></th>
                <th className="min-w-[240px] p-4">Пост</th>
                <th className="p-4 text-right">Просмотры</th>
                <th className="p-4 text-right">Реакции</th>
                <th className="p-4 text-right">Репосты</th>
                <th className="p-4 text-right">Вирал.</th>
                <th className="p-4 text-right">ERV</th>
                <th className="p-4 text-right">ER</th>
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
                    <td className="p-4 text-center">
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
                    <td className="p-4">
                      <div className="max-w-sm space-y-1 md:max-w-md lg:max-w-lg">
                        <div className="line-clamp-1 font-medium text-foreground transition-colors group-hover:text-primary">
                          {post.caption ? <RichText text={post.caption} /> : <span className="italic text-muted-foreground">Без подписи</span>}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{fmt.date(post.date)}</span>
                          {post.albumSize > 1 && (
                            <span className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-2xs font-medium text-secondary-foreground">
                              {post.albumSize} фото
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="p-4 text-right font-medium tabular-nums">{fmt.num(post.reach)}</td>
                    <td className="p-4 text-right font-medium tabular-nums text-muted-foreground">{fmt.num(post.likes)}</td>
                    <td className="p-4 text-right font-medium tabular-nums text-muted-foreground">
                      {post.shares ? fmt.num(post.shares) : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="p-4 text-right font-medium tabular-nums text-muted-foreground">
                      {post.virality != null ? `${post.virality.toFixed(1)}%` : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="p-4 text-right font-medium tabular-nums">
                      <PctTag value={post.erv} green={6} violet={3} />
                    </td>
                    <td className="p-4 text-right font-medium tabular-nums">
                      <PctTag value={post.er} green={1.5} violet={0.5} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {openId !== null && selectedPost && <PostModal post={selectedPost} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function PctTag({ value, green, violet }: { value: number | null; green: number; violet: number }) {
  if (value == null) return <span className="text-muted-foreground/40">—</span>;
  let colorClass = 'text-ember';
  if (value >= green) colorClass = 'text-verdant';
  else if (value >= violet) colorClass = 'text-primary';
  return <span className={`font-medium ${colorClass}`}>{value.toFixed(1)}%</span>;
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
      return `${d.getDate()} ${mon} ${hh}:00`;
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
            {stats.isLoading ? (
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
                          className="flex items-center justify-between rounded border border-border/20 bg-muted/40 p-2 text-xs font-medium"
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
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Skeleton className="h-4 w-1/6" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="flex h-48 flex-col justify-between">
              <Skeleton className="h-24 w-full rounded-none" />
              <div className="space-y-2 p-4">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </Card>
          ))}
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          <Skeleton className="h-12 w-full rounded-none border-b border-border" />
          <div className="space-y-4 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-10 w-10" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/4" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
