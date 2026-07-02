import type { ReactNode } from 'react';
import { useTgFull } from '@/api/queries';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';
import { fmt } from '@/lib/format';
import { pctDelta } from '@/lib/delta';
import { usePeriod } from '@/lib/period';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DeltaPill } from '@/components/DeltaPill';
import { BarChart } from '@/components/BarChart';
import { Breakdown } from '@/components/Breakdown';
import { EmptyState } from '@/components/EmptyState';

function ChartSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-3 text-xs font-medium tracking-wider text-muted-foreground">
        <span className="whitespace-nowrap">{title}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </h3>
      {children}
    </section>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WD_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const CHART_CYCLE = [
  'hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))',
  'hsl(var(--chart-4))', 'hsl(var(--chart-5))', 'hsl(var(--chart-6))',
];

interface Agg {
  views: number;
  reactions: number;
  forwards: number;
  replies: number;
  eng: number;
  count: number;
  avgReach: number;
  er: number;
}

function aggregate(list: NormalizedPost[], members: number): Agg {
  const views = list.reduce((s, p) => s + p.reach, 0);
  const reactions = list.reduce((s, p) => s + p.likes, 0);
  const forwards = list.reduce((s, p) => s + p.shares, 0);
  const replies = list.reduce((s, p) => s + p.comments, 0);
  const eng = list.reduce((s, p) => s + p.eng, 0);
  const count = list.length;
  return {
    views,
    reactions,
    forwards,
    replies,
    eng,
    count,
    avgReach: count ? views / count : 0,
    er: members > 0 ? (eng / members) * 100 : 0,
  };
}

function formatLabel(mediaType: string | null, albumSize: number): string {
  if (albumSize > 1) return 'Альбом';
  if (mediaType === 'photo') return 'Фото';
  if (mediaType === 'video') return 'Видео';
  if (mediaType === 'document') return 'Файл';
  return 'Текст';
}

/**
 * First-class comparison for the Telegram channel: this period vs the previous equal-length
 * window, plus how the period splits by weekday and by post format. The previous window is
 * symmetric (same span immediately before the current one), so a custom date range compares
 * fairly too; all-time has no "previous" → the period table shows a hint instead.
 * (Channel-vs-channel comparison is a separate, heavier feature — it needs multi-channel fetch.)
 */
export function Compare() {
  const { days, range } = usePeriod();
  const { data, isLoading, isError } = useTgFull(days);

  if (isLoading) return <CompareSkeleton />;
  if (isError) return null;

  const members = data?.channel?.memberCount ?? data?.channel?.members ?? 0;
  const all = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {});

  const now = Date.now();
  const to = range ? range.to : now;
  const from = range ? range.from : days > 0 ? now - days * DAY_MS : Number.NEGATIVE_INFINITY;
  const span = to - from;
  const prevFrom = from - span;

  const cur: NormalizedPost[] = [];
  const prev: NormalizedPost[] = [];
  for (const post of all) {
    if (!post.date) continue;
    const t = Date.parse(post.date);
    if (!Number.isFinite(t)) continue;
    if (t >= from && t <= to) cur.push(post);
    else if (t >= prevFrom && t < from) prev.push(post);
  }

  if (cur.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Недостаточно данных для сравнения.
        </CardContent>
      </Card>
    );
  }

  const a = aggregate(cur, members);
  const b = aggregate(prev, members);
  const hasPrev = prev.length > 0;

  // For the "not enough history" explainer: the comparison needs data covering BOTH windows
  // (2×N days), while the archive of loaded posts may cover less — that's also why the Обзор
  // insight (graphs deltas from Telegram) can report a change this tab can't reproduce.
  const periodDays = range ? Math.max(1, Math.round(span / DAY_MS)) : days;
  const oldestTs = all.reduce<number | null>((min, p) => {
    if (!p.date) return min;
    const t = Date.parse(p.date);
    if (!Number.isFinite(t)) return min;
    return min === null || t < min ? t : min;
  }, null);
  const collectedDays = oldestTs != null ? Math.max(1, Math.ceil((now - oldestTs) / DAY_MS)) : null;

  const rows: { label: string; cur: number; prev: number; render: (n: number) => string }[] = [
    { label: 'Просмотры', cur: a.views, prev: b.views, render: fmt.short },
    { label: 'Ср. охват', cur: a.avgReach, prev: b.avgReach, render: fmt.short },
    { label: 'Реакции', cur: a.reactions, prev: b.reactions, render: fmt.short },
    { label: 'Репосты', cur: a.forwards, prev: b.forwards, render: fmt.short },
    { label: 'Комментарии', cur: a.replies, prev: b.replies, render: fmt.short },
    { label: 'Постов', cur: a.count, prev: b.count, render: fmt.num },
    { label: 'ER', cur: a.er, prev: b.er, render: (n) => `${n.toFixed(2)}%` },
  ];

  // By weekday (avg views over the current window).
  const wdViews = Array<number>(7).fill(0);
  const wdCount = Array<number>(7).fill(0);
  cur.forEach((p) => {
    if (!p.date) return;
    // UTC to match the UTC day-keys the daily charts/drill-down bucket by.
    const d = new Date(p.date).getUTCDay();
    wdViews[d] += p.reach;
    wdCount[d] += 1;
  });
  const wdAvg = WD_ORDER.map((i) => (wdCount[i] ? wdViews[i] / wdCount[i] : 0));
  const hasWeekday = wdAvg.some((v) => v > 0);

  // By format (total views per media format over the current window).
  const byFormat = new Map<string, { views: number; count: number }>();
  cur.forEach((p) => {
    const key = formatLabel(p.mediaType, p.albumSize);
    const e = byFormat.get(key) ?? { views: 0, count: 0 };
    e.views += p.reach;
    e.count += 1;
    byFormat.set(key, e);
  });
  const formatItems = [...byFormat.entries()]
    .sort((x, y) => y[1].views - x[1].views)
    .map(([label, v], i) => ({
      label,
      value: v.views,
      display: `${fmt.short(v.views)} · ${v.count} шт`,
      color: CHART_CYCLE[i % CHART_CYCLE.length],
    }));

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <h3 className="flex items-center gap-3 text-xs font-medium tracking-wider text-muted-foreground">
          <span className="whitespace-nowrap">Период vs предыдущий</span>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </h3>
        {hasPrev ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
                  <th className="p-4">Метрика</th>
                  <th className="p-4 text-right">Текущий</th>
                  <th className="p-4 text-right">Предыдущий</th>
                  <th className="p-4 text-right">Δ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.label} className="hover:bg-hover-row">
                    <td className="p-4 text-muted-foreground">{r.label}</td>
                    <td className="p-4 text-right font-medium tabular-nums">{r.render(r.cur)}</td>
                    <td className="p-4 text-right tabular-nums text-muted-foreground">{r.render(r.prev)}</td>
                    <td className="p-4 text-right">
                      <span className="inline-flex justify-end">
                        <DeltaPill delta={pctDelta(r.cur, r.prev)} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : days === 0 && !range ? (
          <EmptyState
            title="Для режима «Всё время» нет предыдущего периода"
            reason="Выберите 7д / 30д / 90д или произвольный диапазон, чтобы сравнить его с таким же окном до него."
          />
        ) : (
          <EmptyState
            title="Недостаточно истории в архиве"
            reason={
              `Для сравнения периодов нужно ${fmt.num(periodDays * 2)} дн. данных в архиве` +
              (collectedDays != null && collectedDays < periodDays * 2
                ? ` — собрано ${fmt.num(collectedDays)} дн.`
                : ' — за предыдущий период постов не найдено.') +
              ' Дельты на Обзоре считаются по данным Telegram, а это сравнение — по архиву собранных постов, поэтому они могут не совпадать.'
            }
          />
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartSection title="Охват по дням недели">
          {hasWeekday ? (
            <BarChart
              values={wdAvg}
              labels={WD_LABELS}
              titles={wdAvg.map((v, i) => `${WD_LABELS[i]}: ${fmt.short(v)} ср. охват`)}
              height={200}
            />
          ) : (
            <EmptyHint />
          )}
        </ChartSection>
        <ChartSection title="По форматам (просмотры)">
          {formatItems.length > 0 ? <Breakdown items={formatItems} /> : <EmptyHint />}
        </ChartSection>
      </div>
    </div>
  );
}

function EmptyHint() {
  return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Нет данных за период</div>;
}

function CompareSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-3 p-5">
              <Skeleton className="h-4 w-1/4" />
              <Skeleton className="h-44 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
