import type { IgData } from '@/lib/useIgData';
import { Section, TrendCard, FollowsByDayCard, SubscriberMovement, igPeriodRows } from '@/components/instagram/shared';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { InsightsBlock, PeriodCompareBlock } from '@/components/instagram/insights';
import { exportIgDaily } from '@/lib/igExport';

/**
 * IG Аналитика — honest dynamics.
 * - Real subscriber movement: gross follows AND unfollows (follows_and_unfollows) → net. Instagram
 *   only gives these as a period total, so they're a summary, not a daily line.
 * - Daily charts ONLY where Instagram returns a real series (reach, daily follows).
 * - Aggregate metrics (views/saves/likes/…) → period comparison, not a fabricated daily graph.
 */
export function IgAnalytics({ ig }: { ig: IgData }) {
  const hasMovement = ig.pairs.follows.hasCur || ig.pairs.unfollows.hasCur;


  const periodRows = igPeriodRows(ig);

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
            className="btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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

      {/* The summary blocks are REAL widgets now (аудит: не-виджетные блоки без ⋯ читались
          непредсказуемо): one group → Выше/Ниже/Переставить/Скрыть, content-height full cards.
          Это и предоплата unified-feed: widget-декларации рендерятся тем же ChartSection. */}
      <WidgetGroup id="ig-analytics-summary" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        {hasMovement && (
          <ChartSection id="ig-movement" title="Движение подписчиков" defaultSize="full" homeKey="ig-movement" noExpand>
            <SubscriberMovement follows={ig.pairs.follows} unfollows={ig.pairs.unfollows} net={ig.netMovement} />
          </ChartSection>
        )}
        <ChartSection id="ig-period-compare" title="Сравнение периодов" defaultSize="full" homeKey="ig-compare" noExpand>
          <p className="text-xs text-muted-foreground">Просмотры, лайки и сохранения сравниваются по периодам.</p>
          <PeriodCompareBlock rows={periodRows} />
        </ChartSection>
        <ChartSection id="ig-insights" title="Главное" defaultSize="full" homeKey="ig-insights" noExpand>
          <InsightsBlock insights={ig.insights} limit={4} />
        </ChartSection>
      </WidgetGroup>
    </div>
  );
}



