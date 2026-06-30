import type { ReactNode } from 'react';
import { useChannels, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import { CollectorEmptyState } from '@/components/CollectorEmptyState';
import { SectionNav, type Section } from '@/components/SectionNav';
import { Hero } from '@/panels/Hero';
import { Digest } from '@/panels/Digest';
import { KpiGrid } from '@/panels/KpiGrid';
import { TopPosts } from '@/panels/TopPosts';
import { Compare } from '@/panels/Compare';
import { HistoryChartBlock, HeatmapChartBlock, VelocityChartBlock } from '@/panels/Charts';

const SECTIONS: readonly Section[] = [
  { id: 'metrics', label: 'Метрики' },
  { id: 'growth', label: 'Рост' },
  { id: 'timing', label: 'Лучшее время' },
  { id: 'velocity', label: 'Скорость' },
  { id: 'compare', label: 'Сравнение' },
  { id: 'top-posts', label: 'Топ-посты' },
];

/**
 * Unified scrollable Overview — the dashboard landing. Composes the migrated panels
 * (KPIs, growth/heatmap/velocity charts, top posts) into one page with sticky section
 * tabs (Variant 1). The standalone Графики route is folded in here.
 */
export function Overview() {
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const { days } = usePeriod();
  const { data, isLoading, isError } = useTgFull(days);

  const channel = channelsData?.channels.find((c) => c.id === channelId);
  const isCollector = channel?.source === 'collector';
  const isEmpty = !isLoading && !isError && !data?.channel && (data?.posts?.length ?? 0) === 0;

  if (isCollector && isEmpty) {
    return <CollectorEmptyState username={channel?.username ?? ''} />;
  }

  return (
    <div>
      <Hero />
      {/* Lead auto-summary — answers "что произошло / что делать" before the detailed sections. */}
      <div className="mt-6">
        <Digest />
      </div>
      <SectionNav sections={SECTIONS} />
      <div className="space-y-12">
        <OverviewSection id="metrics" title="Ключевые метрики">
          <KpiGrid />
        </OverviewSection>
        <OverviewSection id="growth" title="Рост">
          <HistoryChartBlock />
        </OverviewSection>
        <OverviewSection id="timing" title="Лучшее время">
          <HeatmapChartBlock />
        </OverviewSection>
        <OverviewSection id="velocity" title="Скорость">
          <VelocityChartBlock />
        </OverviewSection>
        <OverviewSection id="compare" title="Сравнение">
          <Compare />
        </OverviewSection>
        <OverviewSection id="top-posts" title="Топ-посты">
          <TopPosts />
        </OverviewSection>
      </div>
    </div>
  );
}

function OverviewSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 space-y-4">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}
