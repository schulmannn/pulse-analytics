import { Link } from 'react-router-dom';
import type { IgData } from '@/lib/useIgData';
import { IgKpiBlock } from '@/components/instagram/shared';
import { TopPostsBlock } from '@/components/instagram/content';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { IgNarrativeWeekBlock } from '@/panels/IgNarrativeWeek';

/**
 * IG Обзор — the focused summary, mirroring the Telegram Overview: ALL of it widgets in one
 * reorderable WidgetGroup (the last big IG surface outside the widget system — roadmap card):
 * «Показатели» (KPI hero + ledger), «Лучшие публикации» (a teaser strip
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
      {/* Widget label «Показатели», NOT «Обзор» — the feed block's h2 right above already says
          «Обзор» (the same stutter rule as the TG Overview hero). KPI-герой ведёт Обзор на ОБЕИХ
          сетях (TG-Обзор тоже открывается «Показателями»): большое число + тренд отвечает «как я
          иду?» за секунду, рассказ ниже объясняет «почему». */}
      <ChartSection id="ig-overview-kpi" title="Показатели" defaultSize="full" homeKey="ig-kpi" drillTo="/metrics/ig-reach">
        <IgKpiBlock ig={ig} />
      </ChartSection>
      {/* IG-нарратив под KPI (симметрия с TG-«Неделя канала») — рассказ недели на всю ширину ЖЁСТКО:
          fixedSize игнорирует сохранённый ресайз (треть ширины оставляла 2/3 ряда пустым холстом —
          флагман выглядел сломанным). Home-пин ресайзабелен. Insights-блок «Главное» снят с Обзора
          (канон на IG-Аналитике; снимок недели несут KPI + рассказ) — заодно симметрия с TG-Обзором. */}
      <IgNarrativeWeekBlock id="ig-overview-week" homeKey="ig-week" fixedSize="full" title="Неделя аккаунта" />
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
