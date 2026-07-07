import { fmt } from '@/lib/format';
import type { IgData } from '@/lib/useIgData';
import { Section, TrendCard, FollowsByDayCard, signedNum } from '@/components/instagram/shared';
import { WidgetGroup } from '@/components/ChartWidget';
import { InsightsBlock, PeriodCompareBlock } from '@/components/instagram/insights';
import { exportIgDaily } from '@/lib/igExport';
import { type WindowPair } from '@/lib/igMetrics';

/**
 * IG Аналитика — honest dynamics.
 * - Real subscriber movement: gross follows AND unfollows (follows_and_unfollows) → net. Instagram
 *   only gives these as a period total, so they're a summary, not a daily line.
 * - Daily charts ONLY where Instagram returns a real series (reach, daily follows).
 * - Aggregate metrics (views/saves/likes/…) → period comparison, not a fabricated daily graph.
 */
export function IgAnalytics({ ig }: { ig: IgData }) {
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
      {/* «Динамика» leads — the section's hero (real daily charts); the movement summary follows
          (ИА rule: раздел ведёт его hero-метрика, TG Аналитика тоже открывается динамикой). */}
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
        {/* A real WidgetGroup (TG parity): the cards gain Выше/Ниже/Переставить/Скрыть in the
            ⋯ menu — reorder/hide state persists per user, same as the TG feeds. */}
        <WidgetGroup id="ig-dynamics" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
          {/* Daily metrics with a real page drill INTO it; each card windows the FULL
              archive-backed series by its OWN period pills (per-widget период, TG parity).
              homeKey → the ⋯ menu grows «На главную» (pinned copies render via igHome). */}
          <TrendCard title="Охват по дням" series={ig.series.reach} drillTo="/metrics/ig-reach" homeKey="ig-reach" defaultSize="half" />
          <FollowsByDayCard data={ig.series.follower} drillTo="/metrics/ig-follows" homeKey="ig-follows" />
        </WidgetGroup>
      </Section>

      {hasMovement && (
        <Section title="Движение подписчиков">
          <SubscriberMovement follows={ig.pairs.follows} unfollows={ig.pairs.unfollows} net={ig.netMovement} />
        </Section>
      )}

      <Section title="Сравнение периодов">
        <p className="text-xs text-muted-foreground">Просмотры, лайки и сохранения сравниваются по периодам.</p>
        <PeriodCompareBlock rows={periodRows} />
      </Section>

      <Section title="Главное">
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
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-3">
        {cells.map((c) => (
          <div key={c.label} className="py-1">
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

