import { useIgProfile, useIgInsights, useIgPosts } from '@/api/queries';
import type { IgInsights, IgPost } from '@/api/schemas';
import { fmt } from '@/lib/format';
import { dailyWindowDelta } from '@/lib/delta';
import type { MetricDelta } from '@/lib/delta';
import { usePeriod } from '@/lib/period';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { Skeleton } from '@/components/ui/skeleton';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Point {
  day: string;
  value: number;
}

/** Pull one Graph-API insight metric out as a {day,value}[] series (oldest→newest). */
function metricSeries(insights: IgInsights | undefined, name: string): Point[] {
  const metric = insights?.data?.find((m) => m.name === name);
  return (metric?.values ?? [])
    .map((v) => ({ day: v.end_time ?? '', value: Number(v.value ?? 0) }))
    .filter((p) => p.day !== '');
}

const fmtDay = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
    : '';
};

const MEDIA_LABEL: Record<string, string> = {
  IMAGE: 'Фото',
  CAROUSEL_ALBUM: 'Карусель',
  REELS: 'Reels',
  VIDEO: 'Видео',
};

export function Instagram() {
  const { days } = usePeriod();
  const profile = useIgProfile();
  const insights = useIgInsights();
  const posts = useIgPosts(24);

  const isLoading = profile.isLoading || insights.isLoading || posts.isLoading;
  if (isLoading) return <InstagramSkeleton />;

  if (profile.isError && insights.isError) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не удалось загрузить данные Instagram.
        </CardContent>
      </Card>
    );
  }

  const windowDays = days && days > 0 ? Math.min(days, 90) : 90;
  const since = Date.now() - windowDays * DAY_MS;
  const inWindow = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= since;
  };
  const sumWindow = (series: Point[]) =>
    series.filter((p) => inWindow(p.day)).reduce((acc, p) => acc + p.value, 0);

  const reachSeriesAll = metricSeries(insights.data, 'reach');
  const imprSeriesAll = metricSeries(insights.data, 'impressions');
  const pvSeriesAll = metricSeries(insights.data, 'profile_views');
  const followerSeriesAll = metricSeries(insights.data, 'follower_count');

  const reachWindow = reachSeriesAll.filter((p) => inWindow(p.day));
  const followerWindow = followerSeriesAll.filter((p) => inWindow(p.day));

  const followers = profile.data?.followers_count ?? 0;
  const igPosts = posts.data?.data ?? [];
  const likesTotal = igPosts.reduce((acc, p) => acc + Number(p.like_count ?? 0), 0);
  const savedTotal = igPosts.reduce((acc, p) => acc + Number(p.saved ?? 0), 0);

  const isMock = !!(profile.data?.mock || insights.data?.mock || posts.data?.mock);

  const kpis: KpiCardProps[] = [
    {
      label: 'Подписчики',
      value: fmt.num(followers),
      feature: true,
      trend: dailyWindowDelta(followerSeriesAll, (p) => p.value, windowDays),
      hint: 'всего в аккаунте',
    },
    {
      label: 'Охват за период',
      value: fmt.short(sumWindow(reachSeriesAll)),
      trend: dailyWindowDelta(reachSeriesAll, (p) => p.value, windowDays),
    },
    {
      label: 'Показы',
      value: fmt.short(sumWindow(imprSeriesAll)),
      trend: dailyWindowDelta(imprSeriesAll, (p) => p.value, windowDays),
    },
    {
      label: 'Просмотры профиля',
      value: fmt.short(sumWindow(pvSeriesAll)),
      trend: dailyWindowDelta(pvSeriesAll, (p) => p.value, windowDays),
    },
    { label: 'Лайки', value: fmt.short(likesTotal), hint: `по ${igPosts.length} постам` },
    { label: 'Сохранения', value: fmt.short(savedTotal) },
  ];

  const topPosts = [...igPosts].sort((a, b) => Number(b.reach ?? 0) - Number(a.reach ?? 0)).slice(0, 9);

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">
            Instagram{profile.data?.username ? ` · @${profile.data.username}` : ''}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Обзор аккаунта · охват, вовлечённость и лучшие публикации
          </p>
        </div>
        {isMock && (
          <span className="rounded-full border border-ember/40 bg-ember/10 px-2.5 py-1 text-xs font-medium text-ember">
            Демо-данные · подключите аккаунт для реальных
          </span>
        )}
      </section>

      {/* KPI */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {kpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Охват по дням
            </CardTitle>
          </CardHeader>
          <CardContent>
            {reachWindow.length > 1 ? (
              <LineChart
                values={reachWindow.map((p) => p.value)}
                labels={pickLabels(reachWindow)}
                titles={reachWindow.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)}`)}
                height={220}
              />
            ) : (
              <EmptyChart />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Новые подписчики по дням
            </CardTitle>
          </CardHeader>
          <CardContent>
            {followerWindow.length > 0 ? (
              <BarChart
                values={followerWindow.map((p) => p.value)}
                labels={followerWindow.map((p) => fmtDay(p.day))}
                titles={followerWindow.map((p) => `${fmtDay(p.day)}: +${fmt.num(p.value)}`)}
              />
            ) : (
              <EmptyChart />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top posts */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Лучшие публикации по охвату
        </h3>
        {topPosts.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Публикаций пока нет.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {topPosts.map((post, idx) => (
              <IgPostCard key={post.id ?? idx} post={post} rank={idx + 1} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function pickLabels(series: Point[]): string[] {
  if (series.length === 0) return [];
  const first = series[0];
  const mid = series[Math.floor(series.length / 2)];
  const last = series[series.length - 1];
  return [first?.day ?? '', mid?.day ?? '', last?.day ?? ''].map(fmtDay);
}

interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  feature?: boolean;
  trend?: MetricDelta | null;
}

function KpiCard({ label, value, hint, feature, trend }: KpiCardProps) {
  return (
    <Card className={feature ? 'border-primary/40' : undefined}>
      <CardContent className="p-5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-2 flex items-center gap-2">
          <div className="text-3xl font-semibold tabular-nums">{value}</div>
          <DeltaPill delta={trend} />
        </div>
        {hint ? <div className="mt-2 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

function DeltaPill({ delta }: { delta?: MetricDelta | null }) {
  if (!delta || delta.dir === 'flat') return null;
  const direction = delta.dir === 'up' ? '↑' : '↓';
  const color = delta.dir === 'up' ? 'text-verdant' : 'text-ember';
  const percentage = delta.pct >= 100 ? delta.pct.toFixed(0) : delta.pct.toFixed(1);
  return (
    <span className={`rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums ${color}`}>
      {direction}{percentage}%
    </span>
  );
}

function IgPostCard({ post, rank }: { post: IgPost; rank: number }) {
  const typeLabel = MEDIA_LABEL[post.media_type ?? ''] ?? 'Пост';
  return (
    <Card className="flex flex-col justify-between overflow-hidden">
      <div>
        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-muted/50">
          {post.thumbnail_url || post.media_url ? (
            <img
              src={post.thumbnail_url || post.media_url || ''}
              alt=""
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{typeLabel}</span>
          )}
          <div className="absolute left-2 top-2 rounded bg-background/90 px-2 py-0.5 text-xs font-bold text-foreground shadow-sm">
            #{rank}
          </div>
          <div className="absolute right-2 top-2 rounded bg-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary-foreground">
            {typeLabel}
          </div>
        </div>
        <div className="p-4">
          <p className="line-clamp-3 text-sm leading-relaxed text-foreground">
            {post.caption || <span className="italic text-muted-foreground">Без подписи</span>}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1 border-t border-border/40 bg-muted/10 p-4 pt-0 text-center">
        <Stat label="Охват" value={fmt.short(Number(post.reach ?? 0))} />
        <Stat label="Лайки" value={fmt.short(Number(post.like_count ?? 0))} />
        <Stat label="Комм." value={fmt.short(Number(post.comments_count ?? 0))} />
        <Stat label="Сохр." value={fmt.short(Number(post.saved ?? 0))} />
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="pt-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
      Нет данных за период
    </div>
  );
}

function InstagramSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-3 p-5">
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-8 w-2/3" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-4 p-5">
              <Skeleton className="h-4 w-1/4" />
              <Skeleton className="h-48 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
