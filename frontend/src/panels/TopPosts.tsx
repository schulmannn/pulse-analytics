import { useTgFull } from '@/api/queries';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';
import { fmt } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { RichText } from '@/components/RichText';
import { usePeriod } from '@/lib/period';

/**
 * Top posts grid (legacy "выше среднего по вовлечению" algorithm). Heading-less and
 * self-contained — used both on the Posts panel and inside the unified Overview, so each
 * caller supplies its own surrounding heading/section.
 */
export function TopPosts() {
  const { days, inRange } = usePeriod();
  const { data, isLoading, isError } = useTgFull(days);

  if (isLoading) return <TopPostsSkeleton />;
  if (isError) return null;

  const posts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {}).filter((post) =>
    inRange(post.date),
  );

  const withEng = posts.filter((post) => post.eng > 0);
  let topPosts: NormalizedPost[] = [];
  if (withEng.length > 0) {
    const avgEng = withEng.reduce((sum, post) => sum + post.eng, 0) / withEng.length;
    const aboveAvg = withEng.filter((post) => post.eng > avgEng);
    topPosts = (aboveAvg.length > 0 ? [...aboveAvg] : [...withEng]).sort((a, b) => b.eng - a.eng);
  }
  topPosts = topPosts.slice(0, 6);

  if (topPosts.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Недостаточно данных для топа постов.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {topPosts.map((post, idx) => (
        <Card key={post.id ?? idx} className="flex flex-col justify-between overflow-hidden">
          <div>
            <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-muted/50">
              {post.thumb ? (
                <img
                  src={`${post.thumb}?size=lg`}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="font-mono text-xs text-muted-foreground">Текстовый пост</span>
              )}
              <div className="absolute left-2 top-2 rounded bg-background/90 px-2 py-0.5 text-xs font-bold text-foreground shadow-sm">
                #{idx + 1}
              </div>
              <div className="absolute right-2 top-2 rounded bg-primary px-2 py-0.5 text-[10px] font-bold tracking-wide text-primary-foreground">
                Telegram
              </div>
            </div>
            <div className="space-y-3 p-4">
              <p className="line-clamp-3 text-sm leading-relaxed text-foreground">
                {post.caption ? <RichText text={post.caption} /> : <span className="italic text-muted-foreground">Без подписи</span>}
              </p>
              {post.reactionsDetail.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {post.reactionsDetail.slice(0, 5).map((r, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded-full bg-secondary px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-secondary-foreground"
                    >
                      <span>{r.emoji}</span>
                      <span>{fmt.short(r.count)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 border-t border-border/40 bg-muted/10 p-4 pt-0 text-center">
            <div className="pt-2">
              <div className="text-[10px] font-semibold tracking-wider text-muted-foreground">Просмотры</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{fmt.short(post.reach)}</div>
            </div>
            <div className="pt-2">
              <div className="text-[10px] font-semibold tracking-wider text-muted-foreground">Реакции</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{fmt.short(post.likes)}</div>
            </div>
            <div className="pt-2">
              <div className="text-[10px] font-semibold tracking-wider text-muted-foreground">Репосты</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{fmt.short(post.shares)}</div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function TopPostsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i} className="flex h-56 flex-col justify-between">
          <Skeleton className="h-28 w-full rounded-none" />
          <div className="space-y-2 p-4">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </Card>
      ))}
    </div>
  );
}
