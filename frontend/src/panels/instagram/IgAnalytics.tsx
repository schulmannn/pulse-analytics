import { useOutletContext } from 'react-router-dom';
import { fmt } from '@/lib/format';
import type { IgData } from '@/lib/useIgData';
import { Section, ChartSection, TrendCard, EmptyChart, signedNum } from '@/components/instagram/shared';
import { ExpandableChart } from '@/components/ExpandableChart';
import { BarChart } from '@/components/BarChart';
import { InsightsBlock, PeriodCompareBlock } from '@/components/instagram/insights';
import { exportIgDaily } from '@/lib/igExport';
import { fmtDay, type Point, type WindowPair } from '@/lib/igMetrics';

/**
 * IG Аналитика — honest dynamics.
 * - Real subscriber movement: gross follows AND unfollows (follows_and_unfollows) → net. Instagram
 *   only gives these as a period total, so they're a summary, not a daily line.
 * - Daily charts ONLY where Instagram returns a real series (reach, daily follows).
 * - Aggregate metrics (views/saves/likes/…) → period comparison, not a fabricated daily graph.
 */
export function IgAnalytics() {
  const ig = useOutletContext<IgData>();
  const reachWin = ig.series.reach.filter((p) => ig.inWindow(p.day));
  const followsByDay = ig.series.follower.filter((p) => ig.inWindow(p.day)).slice(-30);
  const hasMovement = ig.pairs.follows.hasCur || ig.pairs.unfollows.hasCur;
  const followsPair = ig.pairs.follows.hasCur ? ig.pairs.follows : ig.pairs.follower;

  const periodRows: { label: string; pair: WindowPair }[] = [
    { label: 'Подписки', pair: followsPair },
    { label: 'Охват', pair: ig.pairs.reach },
    { label: 'Просмотры', pair: ig.pairs.views },
    { label: 'Взаимодействия', pair: ig.pairs.ti },
    { label: 'Вовлечено аккаунтов', pair: ig.pairs.engaged },
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
      follows: ig.series.follower,
      saves: ig.series.saves,
    });

  return (
    <div className="space-y-10">
      {hasMovement && (
        <Section title="Движение подписчиков">
          <SubscriberMovement follows={ig.pairs.follows} unfollows={ig.pairs.unfollows} net={ig.netMovement} />
        </Section>
      )}

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
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <TrendCard title="Охват по дням" series={reachWin} />
          <FollowsByDayCard data={followsByDay} total={followsPair.cur} />
        </div>
      </Section>

      <Section title="Период vs предыдущий">
        <p className="text-xs text-muted-foreground">Просмотры, лайки и сохранения сравниваются по периодам.</p>
        <PeriodCompareBlock rows={periodRows} />
      </Section>

      <Section title="Авто-инсайты">
        <InsightsBlock insights={ig.insights} limit={4} />
      </Section>
    </div>
  );
}

/**
 * Real subscriber movement for the window: gross follows, gross unfollows, and the net of the two.
 * The previous "+595 подписчиков" reported gross follows alone — this shows that 595 follows came
 * with 618 unfollows, so the channel actually moved −23.
 */
function SubscriberMovement({
  follows,
  unfollows,
  net,
}: {
  follows: WindowPair;
  unfollows: WindowPair;
  net: { cur: number; prev: number; hasCur: boolean; hasPrev: boolean };
}) {
  const cells = [
    { label: 'Подписки', text: `+${fmt.num(follows.cur)}`, color: 'text-verdant' },
    { label: 'Отписки', text: `−${fmt.num(unfollows.cur)}`, color: 'text-ember' },
    {
      label: 'Чистый прирост',
      text: signedNum(net.cur),
      color: net.cur > 0 ? 'text-verdant' : net.cur < 0 ? 'text-ember' : 'text-foreground',
    },
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-3">
        {cells.map((c) => (
          <div key={c.label} className="bg-background p-4">
            <div className="text-xs tracking-wide text-muted-foreground">{c.label}</div>
            <div className={`mt-2 text-3xl font-medium tabular-nums tracking-tight ${c.color}`}>{c.text}</div>
            {c.label === 'Чистый прирост' && net.hasPrev && (
              <div className="mt-2 text-xs text-muted-foreground">пред. период: {signedNum(net.prev)}</div>
            )}
          </div>
        ))}
      </div>
      <p className="px-1 text-xs text-muted-foreground">Чистый прирост = подписки − отписки за период.</p>
    </div>
  );
}

function FollowsByDayCard({ data, total }: { data: Point[]; total: number }) {
  return (
    <ChartSection title="Подписки по дням">
      {data.length > 0 ? (
        <ExpandableChart title="Подписки по дням">
          <BarChart
            values={data.map((d) => d.value)}
            labels={data.map((d) => fmtDay(d.day))}
            titles={data.map((d) => `${fmtDay(d.day)}: +${fmt.num(d.value)}`)}
          />
        </ExpandableChart>
      ) : (
        <EmptyChart />
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Всего подписок за период: <span className="font-medium text-verdant">+{fmt.num(total)}</span>
      </p>
    </ChartSection>
  );
}
