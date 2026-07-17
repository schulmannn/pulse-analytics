import { useMemo } from 'react';
import type { IgData } from '@/lib/useIgData';
import { Section, TrendCard, FollowsByDayCard, SubscriberMovement, igPeriodRows } from '@/components/instagram/shared';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { InsightsBlock, PeriodCompareBlock } from '@/components/instagram/insights';
import { buildIgAnalyticsRows } from '@/lib/igAnalyticsExport';
import { downloadAnalyticsCsv, exportFilename } from '@/lib/analyticsExport';

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

  const source = ig.profile?.username ?? '';
  // Aggregate, window-scoped export (current + equal previous where present) — never the full
  // ig.series history, never a fabricated daily value for an aggregate-only metric.
  const exportRows = useMemo(
    () =>
      buildIgAnalyticsRows({
        source,
        window: { since: ig.window.since, until: ig.window.until },
        pairs: {
          reach: ig.pairs.reach,
          views: ig.pairs.views,
          ti: ig.pairs.ti,
          likes: ig.pairs.likes,
          saves: ig.pairs.saves,
          comments: ig.pairs.comments,
          shares: ig.pairs.shares,
        },
        netMovement: ig.netMovement,
        erReach: ig.erReach,
        erReachPrev: ig.erReachPrev,
      }),
    [source, ig.window.since, ig.window.until, ig.pairs, ig.netMovement, ig.erReach, ig.erReachPrev],
  );
  const onExport = () =>
    downloadAnalyticsCsv(
      exportFilename({ network: 'instagram', section: 'analytics', source, from: ig.window.since, to: ig.window.until }),
      exportRows,
    );

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
            disabled={exportRows.length === 0}
            aria-label="Экспорт метрик аналитики за выбранный период в CSV"
            title={exportRows.length === 0 ? 'Нет метрик за выбранный период' : undefined}
            className="btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            Экспорт метрик
          </button>
        }
      >
        {/* A real WidgetGroup (TG parity): the cards gain Выше/Ниже/Переставить/Скрыть in the
            ⋯ menu — reorder/hide state persists per user, same as the TG feeds. */}
        <WidgetGroup id="ig-dynamics" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
          {/* Daily metrics with a real page drill. The feed top bar windows the full archive-backed
              series; a pinned Home copy keeps its own saved period. */}
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



