import type { ReactNode } from 'react';
import { KpiGrid } from '@/panels/KpiGrid';
import { TopPosts } from '@/panels/TopPosts';
import { SubscriberGrowth } from '@/panels/Overview';
import { isLegacyKey, type LegacyKey } from '@/lib/legacyWidgets';

/**
 * Bare-body renderers for the legacy composite widgets — the block CONTENT only (no ChartSection),
 * so ConfigWidget can host it inside the unified card chrome (⋯ menu / expand / reorder / the
 * universal config editor) exactly like a metric widget. Each body reads useWidgetPeriod() for its
 * window; ConfigWidget scopes that to the instance's config.period, and pins the source via a
 * ChannelScope on the card — so a hosted legacy block honours its own period + source at last.
 *
 * U6.3a wires the three BARE blocks (kpi / growth / top-posts). The four own-chrome blocks
 * (history / velocity / heatmap / mentions) render their own ChartSection today and land in U6.3b,
 * once their inner bodies are extracted — until then they keep the legacy HOME_REGISTRY path.
 */
export const LEGACY_RENDER: Partial<Record<LegacyKey, () => ReactNode>> = {
  kpi: () => <KpiGrid />,
  growth: () => <SubscriberGrowth />,
  'top-posts': () => <TopPosts />,
};

/** Is this legacy key wired to render through ConfigWidget yet (U6.3a set)? Own-chrome blocks
 *  (history / velocity / heatmap / mentions) return false until U6.3b extracts their bodies. */
export function isWiredLegacyKey(key: string): key is LegacyKey {
  return isLegacyKey(key) && LEGACY_RENDER[key] !== undefined;
}
