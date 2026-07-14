import { Suspense, lazy, type ReactNode } from 'react';
import { KpiGrid } from '@/panels/KpiGrid';
import { TopPosts } from '@/panels/TopPosts';
import { SubscriberGrowth } from '@/panels/Overview';
import { HeatmapWidgetBody, HistoryWidgetBody, VelocityWidgetBody } from '@/panels/Charts';
import { Skeleton } from '@/components/ui/skeleton';
import type { WidgetConfig } from '@/lib/widgetConfig';
import type { LegacyKey } from '@/lib/legacyWidgets';

// The route and the optional Home widget share one async Mentions chunk. Keeping this adapter lazy
// matters: a static import here would pull the whole Mentions panel back into the entry bundle and
// cancel the route-level split declared in panels/feed/feeds.tsx.
const MentionsWidgetBody = lazy(() =>
  import('@/panels/Mentions').then((module) => ({ default: module.MentionsWidgetBody })),
);

/**
 * Bare-body renderers for the legacy composite widgets — the block CONTENT only (no ChartSection),
 * so ConfigWidget can host it inside the unified card chrome (⋯ menu / expand / reorder / the
 * universal config editor) exactly like a metric widget. Each body reads useWidgetPeriod() for its
 * window; ConfigWidget scopes that to the instance's config.period, and pins the source via a
 * ChannelScope on the card — so a hosted legacy block honours its own period + source at last.
 *
 * Every legacy key is complete here: Home never needs a second own-chrome rendering path.
 */
export const LEGACY_RENDER: Record<LegacyKey, (config: WidgetConfig) => ReactNode> = {
  kpi: () => <KpiGrid />,
  growth: () => <SubscriberGrowth />,
  'top-posts': () => <TopPosts />,
  history: (config) => <HistoryWidgetBody viz={config.viz} />,
  velocity: (config) => <VelocityWidgetBody viz={config.viz} />,
  heatmap: () => <HeatmapWidgetBody />,
  mentions: (config) => (
    <Suspense fallback={<Skeleton className="h-28 w-full" />}>
      <MentionsWidgetBody viz={config.viz} />
    </Suspense>
  ),
};
