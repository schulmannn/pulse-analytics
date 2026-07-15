import type { ReactNode } from 'react';
import { ChartSection } from '@/components/ChartWidget';
import type { WidgetSize } from '@/lib/widgetPrefsStore';
import { NarrativeWeekBlock } from '@/panels/NarrativeWeek';
import { IgNarrativeWeekBlock } from '@/panels/IgNarrativeWeek';
import { IgReachHomeCard, IgFollowsHomeCard, IgKpiHomeCard, IgMovementHomeCard, IgCompareHomeCard, IgInsightsHomeCard } from '@/panels/instagram/igHome';
import { Compare } from '@/panels/Compare';
import { Insights } from '@/panels/Insights';
import type { SourceNetwork } from '@/lib/homeSourceContext';

/**
 * Catalogue of widgets that can be pinned to the personal Home. The seven legacy composite keys
 * are metadata-only here: Home routes them through a deterministic WidgetConfig + ConfigWidget,
 * and components/legacyAdapters owns their bare bodies. Curated cards (week, Instagram, compare,
 * insights) still provide a complete home-scoped card until they get config-driven adapters.
 */
export interface HomeWidgetDef {
  /** Menu / card label. */
  label: string;
  /** Source family shown in the Home card header. */
  network: SourceNetwork;
  /** Default footprint on the 6-col Home grid; omitted → ChartSection's default ('third'). */
  defaultSize?: WidgetSize;
  /** Complete home-scoped card for a curated non-legacy entry. Legacy entries omit this. */
  render?: () => ReactNode;
}

export const HOME_REGISTRY: Record<string, HomeWidgetDef> = {
  kpi: {
    label: 'Показатели',
    network: 'tg',
    defaultSize: 'full',
  },
  growth: {
    label: 'Рост подписчиков',
    network: 'tg',
  },
  week: {
    label: 'Неделя канала',
    network: 'multi',
    // Self-wrapping (NarrativeWeekBlock renders its own ChartSection) — pass the home id/key.
    render: () => <NarrativeWeekBlock id="home-week" homeKey="week" />,
  },
  'top-posts': {
    label: 'Лучшие публикации',
    network: 'tg',
    defaultSize: 'full',
  },
  history: {
    label: 'История подписчиков',
    network: 'tg',
  },
  velocity: {
    label: 'Скорость набора просмотров',
    network: 'tg',
  },
  heatmap: {
    label: 'Тепловая карта активности',
    network: 'tg',
    defaultSize: 'full',
  },
  mentions: {
    label: 'Упоминания по дням',
    network: 'tg',
  },
  // Instagram daily cards — self-fetching wrappers (igHome), so pinning them doesn't drag the
  // ig-prop threading onto Home; an unconnected channel gets an honest connect prompt.
  'ig-reach': {
    label: 'IG · Охват по дням',
    network: 'ig',
    render: () => <IgReachHomeCard id="home-ig-reach" homeKey="ig-reach" />,
  },
  'ig-follows': {
    label: 'IG · Подписки по дням',
    network: 'ig',
    render: () => <IgFollowsHomeCard id="home-ig-follows" homeKey="ig-follows" />,
  },
  'ig-week': {
    label: 'IG · Неделя',
    network: 'ig',
    // Self-wrapping (IgNarrativeWeekBlock renders its own ChartSection) — pass the home id/key.
    render: () => <IgNarrativeWeekBlock id="home-ig-week" homeKey="ig-week" />,
  },
  'tg-compare': {
    label: 'Сравнение периодов',
    network: 'tg',
    defaultSize: 'full',
    render: () => (
      <ChartSection id="home-tg-compare" homeKey="tg-compare" title="Сравнение периодов" defaultSize="full" noExpand>
        <Compare />
      </ChartSection>
    ),
  },
  'tg-insights': {
    label: 'Главное (Аналитика)',
    network: 'tg',
    defaultSize: 'full',
    render: () => (
      <ChartSection id="home-tg-insights" homeKey="tg-insights" title="Главное" defaultSize="full" noExpand>
        <Insights />
      </ChartSection>
    ),
  },
  'ig-compare': {
    label: 'IG · Сравнение периодов',
    network: 'ig',
    defaultSize: 'full',
    render: () => <IgCompareHomeCard id="home-ig-compare" homeKey="ig-compare" />,
  },
  'ig-insights': {
    label: 'IG · Главное',
    network: 'ig',
    defaultSize: 'full',
    render: () => <IgInsightsHomeCard id="home-ig-insights" homeKey="ig-insights" />,
  },
  'ig-movement': {
    label: 'IG · Движение подписчиков',
    network: 'ig',
    defaultSize: 'full',
    render: () => <IgMovementHomeCard id="home-ig-movement" homeKey="ig-movement" />,
  },
  'ig-kpi': {
    label: 'IG · Показатели',
    network: 'ig',
    defaultSize: 'full',
    render: () => <IgKpiHomeCard id="home-ig-kpi" homeKey="ig-kpi" />,
  },
};
