import { Link } from 'react-router-dom';
import { useChannels, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import { CollectorEmptyState } from '@/components/CollectorEmptyState';
import { DataHealth } from '@/components/DataHealth';
import { Digest } from '@/panels/Digest';
import { KpiGrid } from '@/panels/KpiGrid';
import { TopPosts } from '@/panels/TopPosts';

/**
 * Overview — the focused summary (Figma "Pulse Refined Technical"): a KPI hero + ledger, then an
 * Insight | Data-health two-column, then the top-posts table. Hairline-delimited, no cards, no tabs.
 * The deep breakdowns (рост, лучшее время, скорость, сравнение, авто-инсайты) live on the Аналитика
 * route — reachable via "Открыть аналитику →".
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
      {/* KPI hero (Просмотры) + ledger (Подписчики / Ср.охват / Реакции / ER) */}
      <KpiGrid />

      {/* Insight | Состояние данных */}
      <div className="mt-8 grid grid-cols-1 gap-8 border-t border-border pt-8 lg:grid-cols-2 lg:gap-12">
        <Digest />
        <DataHealth />
      </div>

      {/* Топ постов */}
      <section className="mt-8 space-y-4 border-t border-border pt-8">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium tracking-wide text-muted-foreground">Топ постов</h2>
          <Link to="/analytics" className="shrink-0 text-[13px] font-medium text-primary hover:underline">
            <span className="md:hidden">Аналитика →</span><span className="hidden md:inline">Открыть аналитику →</span>
          </Link>
        </div>
        <TopPosts />
      </section>
    </div>
  );
}
