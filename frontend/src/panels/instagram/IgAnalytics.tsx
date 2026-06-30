import { useOutletContext } from 'react-router-dom';
import { fmt } from '@/lib/format';
import type { IgData } from '@/lib/useIgData';
import { Section, ChartSection, TrendCard, EmptyChart } from '@/components/instagram/shared';
import { ExpandableChart } from '@/components/ExpandableChart';
import { BarChart } from '@/components/BarChart';
import { InsightsBlock, PeriodCompareBlock } from '@/components/instagram/insights';
import { exportIgDaily } from '@/lib/igExport';
import { fmtDay, type Point, type WindowPair } from '@/lib/igMetrics';

/**
 * IG Аналитика — honest dynamics. Daily charts ONLY for metrics Instagram actually returns as a
 * series (reach, new followers). Everything else (views/saves/likes/shares/…) arrives as
 * current-vs-previous totals, so it's shown as a period comparison, not a fabricated daily graph.
 */
export function IgAnalytics() {
  const ig = useOutletContext<IgData>();
  const reachWin = ig.series.reach.filter((p) => ig.inWindow(p.day));
  const newFollowersByDay = ig.series.follower.filter((p) => ig.inWindow(p.day)).slice(-30);

  const periodRows: { label: string; pair: WindowPair }[] = [
    { label: 'Охват', pair: ig.pairs.reach },
    { label: 'Просмотры', pair: ig.pairs.views },
    { label: 'Взаимодействия', pair: ig.pairs.ti },
    { label: 'Вовлечено аккаунтов', pair: ig.pairs.engaged },
    { label: 'Новые подписчики', pair: ig.pairs.follower },
    { label: 'Лайки', pair: ig.pairs.likes },
    { label: 'Комментарии', pair: ig.pairs.comments },
    { label: 'Сохранения', pair: ig.pairs.saves },
    { label: 'Репосты', pair: ig.pairs.shares },
  ];

  const onExport = () =>
    exportIgDaily({
      reach: ig.series.reach,
      views: ig.series.views,
      total_interactions: ig.series.ti,
      accounts_engaged: ig.series.engaged,
      new_followers: ig.series.follower,
      saves: ig.series.saves,
    });

  return (
    <div className="space-y-10">
      <Section
        title="Динамика"
        action={
          <button
            type="button"
            onClick={onExport}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            Экспорт метрик
          </button>
        }
      >
        <p className="text-xs text-muted-foreground">
          Дневной график строим только по метрикам, которые Instagram отдаёт по дням — охват и подписчики.
        </p>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <TrendCard title="Охват по дням" series={reachWin} />
          <NewFollowersCard data={newFollowersByDay} total={ig.pairs.follower.cur} />
        </div>
      </Section>

      <Section title="Период vs предыдущий">
        <p className="text-xs text-muted-foreground">
          Просмотры, сохранения, лайки и репосты Instagram отдаёт суммой за период (без дневного ряда) — поэтому
          честнее сравнить окна, чем рисовать график.
        </p>
        <PeriodCompareBlock rows={periodRows} />
      </Section>

      <Section title="Авто-инсайты">
        <InsightsBlock insights={ig.insights} limit={4} />
      </Section>
    </div>
  );
}

function NewFollowersCard({ data, total }: { data: Point[]; total: number }) {
  return (
    <ChartSection title="Новые подписчики по дням">
      {data.length > 0 ? (
        <ExpandableChart title="Новые подписчики по дням">
          <BarChart
            values={data.map((d) => d.value)}
            labels={data.map((d) => fmtDay(d.day))}
            titles={data.map((d) => `${fmtDay(d.day)}: +${fmt.num(d.value)}`)}
          />
        </ExpandableChart>
      ) : (
        <EmptyChart />
      )}
      <p className="mt-3 text-xs font-medium text-muted-foreground">
        Всего за период: <span className="text-verdant">+{fmt.num(total)}</span> новых подписчиков
      </p>
    </ChartSection>
  );
}
