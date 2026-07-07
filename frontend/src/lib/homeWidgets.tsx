import type { ReactNode } from 'react';
import { ChartSection, type WidgetSize } from '@/components/ChartWidget';
import { KpiGrid } from '@/panels/KpiGrid';
import { Digest } from '@/panels/Digest';
import { TopPosts } from '@/panels/TopPosts';
import { HistoryChartBlock, VelocityChartBlock, HeatmapChartBlock } from '@/panels/Charts';
import { GrowthChartBlock } from '@/panels/Overview';
import { HomeMentionsByDay } from '@/panels/Mentions';
import { IgReachHomeCard, IgFollowsHomeCard, IgKpiHomeCard } from '@/panels/instagram/igHome';

/**
 * Personal-Home widget registry — the catalogue of widgets a user can pin to /home via the
 * ⋯ «На главную» item. Each entry's `render()` returns a COMPLETE, home-scoped card:
 *
 *   - The four Overview widgets are BARE content (no own ChartSection), so the registry wraps
 *     each in a fresh `<ChartSection id="home-<key>" homeKey="<key>" …>`. The `home-*` id is a
 *     brand-new prefs identity — arranging the pinned copy on Home never mutates the Overview
 *     copy (which lives under `overview-*`). We pass `periodControl` so each Home card carries
 *     its own 7д/30д/90д/Всё window (default 30д), independent from Overview.
 *
 *   - The two Charts blocks ALREADY render their own ChartSection, so we do NOT wrap them again
 *     (that would nest a card in a card + a second ⋯ menu). Instead we pass them a home-scoped
 *     `id`/`homeKey` and let their existing ChartSection take that id. They are period-agnostic
 *     (they plot the full archive / velocity), so no periodControl there.
 *
 * The `homeKey` on every card matches its registry key, so each pinned card's ⋯ menu reads
 * «Убрать с главной» for an in-place unpin.
 *
 * DEFERRED (not cleanly self-contained — revisit with a self-fetching wrapper):
 *   - All Instagram widgets: they take `ig: IgData` as a PROP (useIgData is called once in
 *     IgFeed and threaded down) and read the GLOBAL usePeriod, not useWidgetPeriod. Pinning one
 *     would pull the whole ig-* cluster + global-period coupling onto Home.
 *   - Mentions «Кто упоминает» / «Последние упоминания»: still computed in the Mentions() parent
 *     and passed as pre-baked props. («Упоминаний по дням» IS now pinnable — HomeMentionsByDay
 *     self-fetches the free mentions archive.)
 *
 * Heatmap (Charts) is pinnable: it self-fetches useTgFull(0) and windows client-side, carrying
 * its own period pills (per-widget period, #10), so it needs no wrapper.
 */
export interface HomeWidgetDef {
  /** Menu / card label. */
  label: string;
  /** Default footprint on the 6-col Home grid; omitted → the card's own default ('half'). */
  defaultSize?: WidgetSize;
  /** A complete, home-scoped card (its own ChartSection with a `home-<key>` id + homeKey). */
  render: () => ReactNode;
}

export const HOME_REGISTRY: Record<string, HomeWidgetDef> = {
  kpi: {
    label: 'Показатели',
    defaultSize: 'full',
    render: () => (
      <ChartSection id="home-kpi" homeKey="kpi" title="Показатели" defaultSize="full" periodControl drillTo="/metrics/views">
        <KpiGrid />
      </ChartSection>
    ),
  },
  digest: {
    label: 'Главное',
    // Narrative insight takes a content-height `full` card (no fixed tile → no inner scrollbar).
    render: () => (
      <ChartSection id="home-digest" homeKey="digest" title="Главное" periodControl defaultSize="full">
        <Digest />
      </ChartSection>
    ),
  },
  growth: {
    label: 'Рост подписчиков',
    // Self-wrapping (like History/Velocity/Heatmap): «Развернуть» opens a full subscriber chart, not
    // the compact sparkline over an empty fullscreen. Pass the home id/key, don't re-wrap.
    render: () => <GrowthChartBlock id="home-growth" homeKey="growth" />,
  },
  'top-posts': {
    label: 'Лучшие публикации',
    defaultSize: 'full',
    render: () => (
      <ChartSection id="home-top-posts" homeKey="top-posts" title="Лучшие публикации" defaultSize="full" periodControl>
        <TopPosts />
      </ChartSection>
    ),
  },
  history: {
    label: 'История подписчиков',
    // HistoryChartBlock renders its OWN ChartSection — pass it the home id/key, don't wrap.
    render: () => <HistoryChartBlock id="home-history" homeKey="history" />,
  },
  velocity: {
    label: 'Скорость набора просмотров',
    render: () => <VelocityChartBlock id="home-velocity" homeKey="velocity" />,
  },
  heatmap: {
    label: 'Тепловая карта активности',
    defaultSize: 'full',
    // Renders its OWN ChartSection (like History/Velocity) — pass the home id/key, don't wrap.
    // Carries its own 7д/30д/90д/Всё pills (default 30д), windowing one useTgFull(0) fetch
    // client-side — no per-period fetch fan-out.
    render: () => <HeatmapChartBlock id="home-heatmap" homeKey="heatmap" />,
  },
  mentions: {
    label: 'Упоминания по дням',
    // Self-fetching (free mentions archive, no live-search quota) — no wrapper needed.
    render: () => <HomeMentionsByDay id="home-mentions" homeKey="mentions" />,
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
  'ig-kpi': {
    label: 'IG · Показатели',
    defaultSize: 'full',
    render: () => <IgKpiHomeCard id="home-ig-kpi" homeKey="ig-kpi" />,
  },
};

/** Registry keys that seed a sensible default Home for a first-time user («Собрать по умолчанию»). */
export const HOME_DEFAULT_KEYS = ['kpi', 'digest', 'growth', 'top-posts'];
