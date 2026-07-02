import type { ReactNode } from 'react';
import { ChartSection, type WidgetSize } from '@/components/ChartWidget';
import { KpiGrid } from '@/panels/KpiGrid';
import { Digest } from '@/panels/Digest';
import { TopPosts } from '@/panels/TopPosts';
import { SubscriberGrowth } from '@/panels/Overview';
import { HistoryChartBlock, VelocityChartBlock } from '@/panels/Charts';

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
 *   - Mentions blocks («Упоминаний по дням», «Кто упоминает», «Последние упоминания»): their
 *     data is computed in the Mentions() parent (useMentions/useMentionsArchive) and passed to
 *     the ChartSections as pre-baked props — the sections are not self-contained.
 *   - Heatmap (Charts): pinnable in principle, but it calls useTgFull(days) with the WIDGET
 *     period as the FETCH arg, so a non-default Home period spawns an extra request. Left out
 *     of v1 (History + Velocity cover the Charts surface).
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
      <ChartSection id="home-kpi" homeKey="kpi" title="Показатели" defaultSize="full" periodControl>
        <KpiGrid />
      </ChartSection>
    ),
  },
  digest: {
    label: 'Инсайт',
    render: () => (
      <ChartSection id="home-digest" homeKey="digest" title="Инсайт" periodControl>
        <Digest />
      </ChartSection>
    ),
  },
  growth: {
    label: 'Рост подписчиков',
    render: () => (
      <ChartSection id="home-growth" homeKey="growth" title="Рост подписчиков" periodControl>
        <SubscriberGrowth />
      </ChartSection>
    ),
  },
  'top-posts': {
    label: 'Топ постов',
    defaultSize: 'full',
    render: () => (
      <ChartSection id="home-top-posts" homeKey="top-posts" title="Топ постов" defaultSize="full" periodControl>
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
};

/** Registry keys that seed a sensible default Home for a first-time user («Собрать по умолчанию»). */
export const HOME_DEFAULT_KEYS = ['kpi', 'digest', 'growth', 'top-posts'];
