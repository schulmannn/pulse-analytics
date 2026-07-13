import type { ReactNode } from 'react';
import { ChartSection } from '@/components/ChartWidget';
import type { WidgetSize } from '@/lib/widgetPrefsStore';
import { NarrativeWeekBlock } from '@/panels/NarrativeWeek';
import { IgNarrativeWeekBlock } from '@/panels/IgNarrativeWeek';
import { IgReachHomeCard, IgFollowsHomeCard, IgKpiHomeCard, IgMovementHomeCard, IgCompareHomeCard, IgInsightsHomeCard } from '@/panels/instagram/igHome';
import { Compare } from '@/panels/Compare';
import { Insights } from '@/panels/Insights';

/**
 * Catalogue of widgets that can be pinned to the personal Home. The seven legacy composite keys
 * are metadata-only here: Home routes them through a deterministic WidgetConfig + ConfigWidget,
 * and components/legacyAdapters owns their bare bodies. Curated cards (week, Instagram, compare,
 * insights) still provide a complete home-scoped card until they get config-driven adapters.
 */
export interface HomeWidgetDef {
  /** Menu / card label. */
  label: string;
  /** Default footprint on the 6-col Home grid; omitted → ChartSection's default ('third'). */
  defaultSize?: WidgetSize;
  /** Complete home-scoped card for a curated non-legacy entry. Legacy entries omit this. */
  render?: () => ReactNode;
}

export const HOME_REGISTRY: Record<string, HomeWidgetDef> = {
  kpi: {
    label: 'Показатели',
    defaultSize: 'full',
  },
  growth: {
    label: 'Рост подписчиков',
  },
  week: {
    label: 'Неделя канала',
    // Self-wrapping (NarrativeWeekBlock renders its own ChartSection) — pass the home id/key.
    render: () => <NarrativeWeekBlock id="home-week" homeKey="week" />,
  },
  'top-posts': {
    label: 'Лучшие публикации',
    defaultSize: 'full',
  },
  history: {
    label: 'История подписчиков',
  },
  velocity: {
    label: 'Скорость набора просмотров',
  },
  heatmap: {
    label: 'Тепловая карта активности',
    defaultSize: 'full',
  },
  mentions: {
    label: 'Упоминания по дням',
  },
  // Instagram daily cards — self-fetching wrappers (igHome), so pinning them doesn't drag the
  // ig-prop threading onto Home; an unconnected channel gets an honest connect prompt.
  'ig-reach': {
    label: 'IG · Охват по дням',
    render: () => <IgReachHomeCard id="home-ig-reach" homeKey="ig-reach" />,
  },
  'ig-follows': {
    label: 'IG · Подписки по дням',
    render: () => <IgFollowsHomeCard id="home-ig-follows" homeKey="ig-follows" />,
  },
  'ig-week': {
    label: 'IG · Неделя',
    // Self-wrapping (IgNarrativeWeekBlock renders its own ChartSection) — pass the home id/key.
    render: () => <IgNarrativeWeekBlock id="home-ig-week" homeKey="ig-week" />,
  },
  'tg-compare': {
    label: 'Сравнение периодов',
    defaultSize: 'full',
    render: () => (
      <ChartSection id="home-tg-compare" homeKey="tg-compare" title="Сравнение периодов" defaultSize="full" noExpand>
        <Compare />
      </ChartSection>
    ),
  },
  'tg-insights': {
    label: 'Главное (Аналитика)',
    defaultSize: 'full',
    render: () => (
      <ChartSection id="home-tg-insights" homeKey="tg-insights" title="Главное" defaultSize="full" noExpand>
        <Insights />
      </ChartSection>
    ),
  },
  'ig-compare': {
    label: 'IG · Сравнение периодов',
    defaultSize: 'full',
    render: () => <IgCompareHomeCard id="home-ig-compare" homeKey="ig-compare" />,
  },
  'ig-insights': {
    label: 'IG · Главное',
    defaultSize: 'full',
    render: () => <IgInsightsHomeCard id="home-ig-insights" homeKey="ig-insights" />,
  },
  'ig-movement': {
    label: 'IG · Движение подписчиков',
    defaultSize: 'full',
    render: () => <IgMovementHomeCard id="home-ig-movement" homeKey="ig-movement" />,
  },
  'ig-kpi': {
    label: 'IG · Показатели',
    defaultSize: 'full',
    render: () => <IgKpiHomeCard id="home-ig-kpi" homeKey="ig-kpi" />,
  },
};

/** Registry keys that seed a sensible default Home for a first-time user («Собрать по умолчанию»). */
export const HOME_DEFAULT_KEYS = ['week', 'kpi', 'growth', 'ig-reach', 'top-posts'];
