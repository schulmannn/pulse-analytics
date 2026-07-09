import { Link } from 'react-router-dom';
import type { IgData } from '@/lib/useIgData';
import { IgKpiBlock } from '@/components/instagram/shared';
import { InsightsBlock } from '@/components/instagram/insights';
import { TopPostsBlock } from '@/components/instagram/content';
import { ChartSection, WidgetGroup } from '@/components/ChartWidget';
import { IgNarrativeWeekBlock } from '@/panels/IgNarrativeWeek';

/**
 * IG Обзор — the focused summary, mirroring the Telegram Overview: ALL of it widgets in one
 * reorderable WidgetGroup (the last big IG surface outside the widget system — roadmap card):
 * «Показатели» (KPI hero + ledger), «Главное» (auto-insights), «Лучшие публикации» (a teaser strip
 * with the link into Контент). Every card gets the full ⋯ contract — Размер in the dialog,
 * Выше/Ниже/Переставить/Скрыть in the menu, «На главную» where a self-fetching Home twin exists.
 *
 * No per-widget periodControl here: these bodies read the GLOBAL IG window (ig.pairs/ig.window),
 * so the section header's period chips are the honest control — a per-card pill would silently
 * lie (per-widget IG windows are the noted follow-up).
 */
export function IgOverview({ ig }: { ig: IgData }) {
  return (
    <WidgetGroup id="ig-overview" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
      {/* IG-нарратив ведёт Обзор (симметрия с TG-«Неделя канала» на TG-Обзоре) — рассказ недели
          на всю ширину, самофетч, числа сходятся со страницами /metrics/ig-*. */}
      <IgNarrativeWeekBlock id="ig-overview-week" homeKey="ig-week" defaultSize="full" />
      {/* Widget label «Показатели», NOT «Обзор» — the feed block's h2 right above already says
          «Обзор» (the same stutter rule as the TG Overview hero). */}
      <ChartSection id="ig-overview-kpi" title="Показатели" defaultSize="full" homeKey="ig-kpi" drillTo="/metrics/ig-reach">
        <IgKpiBlock ig={ig} />
      </ChartSection>
      <ChartSection id="ig-overview-insights" title="Главное" defaultSize="full">
        <InsightsBlock insights={ig.insights} limit={3} />
      </ChartSection>
      <ChartSection
        id="ig-overview-top-posts"
        title="Лучшие публикации"
        defaultSize="full"
        action={
          <Link to="/instagram/content" className="shrink-0 text-xs font-medium text-primary hover:underline">
            <span className="md:hidden">Контент →</span>
            <span className="hidden md:inline">Открыть контент →</span>
          </Link>
        }
      >
        <TopPostsBlock posts={ig.postsInWindow} limit={3} showSort={false} />
      </ChartSection>
    </WidgetGroup>
  );
}
