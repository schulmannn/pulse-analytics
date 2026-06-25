import type { ReactNode } from 'react';
import { useTgFull, useTgGraphs } from '@/api/queries';
import { normalizeTgPosts } from '@/lib/posts';
import { fmt } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { inRangeByDays, usePeriod } from '@/lib/period';
import { Skeleton } from '@/components/ui/skeleton';

export function Digest() {
  const { days } = usePeriod();
  const { data: full, isLoading: isFullLoading } = useTgFull(days);
  const { data: graphs, isLoading: isGraphsLoading } = useTgGraphs();

  if (isFullLoading || isGraphsLoading) {
    return (
      <Card>
        <CardHeader><Skeleton className="h-4 w-1/3" /></CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-4/5" />
        </CardContent>
      </Card>
    );
  }

  const posts = normalizeTgPosts(full?.posts ?? [], full?.channel ?? {}).filter((post) =>
    inRangeByDays(post.date, days),
  );
  const totalViews = posts.reduce((sum, post) => sum + post.reach, 0);
  const postsN = posts.length;
  const avgViews = postsN > 0 ? totalViews / postsN : 0;

  let netSubscribers: number | null = null;
  const fSeries = graphs?.followers?.series ?? [];
  const joinedSeries = fSeries.find((s) => /join|подпис/i.test(s.name ?? ''));
  const leftSeries = fSeries.find((s) => /left|отпис/i.test(s.name ?? ''));
  if (joinedSeries && leftSeries) {
    const mLen = Math.min(joinedSeries.values.length, leftSeries.values.length);
    let totalJ = 0;
    let totalL = 0;
    for (let i = 0; i < mLen; i++) {
      totalJ += Number(joinedSeries.values[i] ?? 0);
      totalL += Number(leftSeries.values[i] ?? 0);
    }
    netSubscribers = totalJ - totalL;
  }

  const activeErvs = posts.map((p) => p.erv).filter((v): v is number => v !== null);
  const avgErv = activeErvs.length ? activeErvs.reduce((a, b) => a + b, 0) / activeErvs.length : null;

  const bestPost = posts.length > 0 ? [...posts].sort((a, b) => b.reach - a.reach)[0] : null;

  const wdViews: number[] = Array(7).fill(0);
  const wdCount: number[] = Array(7).fill(0);
  full?.posts?.forEach((p) => {
    if (!inRangeByDays(p.date, days) || !p.date) return;
    const day = new Date(p.date).getDay();
    wdViews[day] += Number(p.views ?? p.view_count ?? 0);
    wdCount[day] += 1;
  });
  const wdOrder = [1, 2, 3, 4, 5, 6, 0];
  const wdLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const wdAvg = wdOrder.map((idx) => {
    const count = wdCount[idx] ?? 0;
    return count ? (wdViews[idx] ?? 0) / count : 0;
  });
  const maxWd = Math.max(...wdAvg);
  const bestWd = maxWd > 0 ? wdLabels[wdAvg.indexOf(maxWd)] : null;

  let peakHour: number | null = null;
  const thData = graphs?.top_hours;
  if (thData && thData.values.length > 0) {
    const pi = thData.values.indexOf(Math.max(...thData.values));
    peakHour = thData.hours[pi] ?? pi;
  }

  const hasSchedulingAdvice = bestWd || peakHour !== null;

  if (posts.length === 0 && !graphs) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Недостаточно данных для авто-сводки.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Итоги · авто-сводка</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3.5 text-sm leading-relaxed">
          <li className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
            <span>
              <strong className="font-semibold text-foreground">{fmt.short(totalViews)}</strong> просмотров за период ·{' '}
              {postsN} постов · в среднем <strong className="font-semibold text-foreground">{fmt.short(avgViews)}</strong> на пост.
            </span>
          </li>

          {netSubscribers !== null && (
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                Подписчики:{' '}
                <strong className="font-semibold text-foreground">{netSubscribers >= 0 ? '+' : ''}{fmt.num(netSubscribers)}</strong>{' '}
                чистыми за период.
              </span>
            </li>
          )}

          {avgErv !== null && (
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>Средний ERV <strong className="font-semibold text-foreground">{avgErv.toFixed(1)}%</strong> — вовлечённость на просмотр.</span>
            </li>
          )}

          {bestPost && bestPost.reach > 0 && (
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                Топ-пост: «{(bestPost.caption || 'без подписи').slice(0, 70)}» —{' '}
                <strong className="font-semibold text-foreground">{fmt.short(bestPost.reach)}</strong> просмотров
                {bestPost.erv !== null ? `, ERV ${bestPost.erv.toFixed(1)}%` : ''}.
              </span>
            </li>
          )}

          {hasSchedulingAdvice && (
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                Когда постить:{' '}
                {[
                  bestWd ? <span key="wd">день — <strong className="font-semibold text-foreground">{bestWd}</strong></span> : null,
                  peakHour !== null ? <span key="hr">час — <strong className="font-semibold text-foreground">{peakHour}:00</strong></span> : null,
                ]
                  .filter(Boolean)
                  .reduce<ReactNode[]>((acc, elem, idx) => (idx === 0 ? [elem] : [...acc, ', ', elem]), [])}
                .
              </span>
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
