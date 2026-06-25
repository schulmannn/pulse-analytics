import { useTgFull } from '@/api/queries';
import { fmt, sparkAreaPath, sparkPath } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';

interface Kpi {
  label: string;
  value: string;
  delta?: string | null;
  feature?: boolean;
  spark?: number[];
}

/**
 * Telegram KPI cards — ported from legacy renderKpis() (TG branch), wired to the data
 * /api/tg/full actually returns (channel + views_summary). Graph-derived trend deltas
 * (Δ vs previous period) come later when the charts panel migrates its extra endpoints.
 */
export function KpiGrid() {
  const { data, isLoading, isError, error } = useTgFull();

  if (isLoading) return <KpiSkeletons />;
  if (isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не удалось загрузить метрики: {error instanceof Error ? error.message : 'ошибка'}
        </CardContent>
      </Card>
    );
  }

  const members = data?.channel?.memberCount ?? data?.channel?.members ?? 0;
  const vs = data?.views_summary ?? null;
  const totalViews = vs?.total_views ?? 0;
  const totalReactions = vs?.total_reactions ?? 0;
  const totalForwards = vs?.total_forwards ?? 0;
  const totalReplies = vs?.total_replies ?? 0;
  const avgViews = vs?.avg_views ?? 0;
  const postsAnalyzed = vs?.posts_analyzed ?? 0;
  const er = members > 0 ? ((totalReactions + totalReplies + totalForwards) / members) * 100 : 0;

  const spark = vs?.views_by_day
    ? Object.entries(vs.views_by_day)
        .map(([day, v]) => {
          const [d, m] = day.split('.').map(Number);
          return { ts: new Date(new Date().getFullYear(), (m || 1) - 1, d || 1).getTime(), v: Number(v) || 0 };
        })
        .sort((a, b) => a.ts - b.ts)
        .map((e) => e.v)
    : [];

  const cards: Kpi[] = [
    { feature: true, label: 'Подписчики', value: fmt.num(members), delta: 'в канале', spark },
    {
      label: 'Просмотры за период',
      value: fmt.short(totalViews),
      delta: postsAnalyzed ? `по ${postsAnalyzed} постам` : null,
      spark,
    },
    { label: 'Ср. охват поста', value: fmt.short(avgViews) },
    {
      label: 'Реакции',
      value: fmt.short(totalReactions),
      delta: postsAnalyzed ? `${(totalReactions / Math.max(postsAnalyzed, 1)).toFixed(1)} на пост` : null,
    },
    {
      label: 'Репосты',
      value: fmt.short(totalForwards),
      delta: totalReplies ? `${fmt.short(totalReplies)} комментариев` : null,
    },
    {
      label: 'Вовлечённость (ER)',
      value: er > 0 ? er.toFixed(2) + '%' : '—',
      delta: '(реакции+репосты+комменты) / подписчики',
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c, i) => (
        <Card key={i} className={c.feature ? 'border-primary/40' : undefined}>
          <CardContent className="relative overflow-hidden p-5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.label}</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{c.value}</div>
            {c.delta ? <div className="mt-2 text-xs text-muted-foreground">{c.delta}</div> : null}
            {c.spark && c.spark.length > 1 ? (
              <svg className="mt-3 h-8 w-full" viewBox="0 0 200 32" preserveAspectRatio="none">
                <path d={sparkAreaPath(c.spark)} fill="hsl(var(--brand-iris))" opacity="0.08" />
                <path
                  d={sparkPath(c.spark)}
                  fill="none"
                  stroke="hsl(var(--brand-iris))"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function KpiSkeletons() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="p-5">
            <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
            <div className="mt-3 h-8 w-2/3 animate-pulse rounded bg-muted" />
            <div className="mt-3 h-3 w-2/5 animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
