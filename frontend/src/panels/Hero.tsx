import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import { fmt } from '@/lib/format';
import { freshness, latestHistoryDay } from '@/lib/freshness';
import { ChannelAvatar } from '@/components/ChannelAvatar';
import { MetricInfo } from '@/components/InfoTooltip';
import { SourceStatus } from '@/components/SourceStatus';
import { METRIC_DEFS } from '@/lib/metricDefs';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Overview header — the channel's identity (avatar + @handle + network · subscribers).
 * Anchors the page and works on mobile where the sidebar card is hidden. The period lives
 * in the top bar, so it isn't repeated here. Metrics are carried by the KPI cards below.
 */
export function Hero() {
  const { days } = usePeriod();
  const { data: channelsData, isLoading: channelsLoading } = useChannels();
  const { channelId } = useSelectedChannel();
  const { data, isLoading } = useTgFull(days);
  const { data: history } = useHistory(730);

  const channels = channelsData?.channels ?? [];
  const current = channels.find((c) => c.id === channelId) ?? channels[0];
  const fresh = freshness(latestHistoryDay(history), Date.now());

  // Identity comes from the channels query, so gate the skeleton on it too (not just tg-full).
  if ((channelsLoading || isLoading) && !current) {
    return (
      <section className="flex items-center gap-3.5">
        <Skeleton className="h-12 w-12 rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-3.5 w-28" />
        </div>
      </section>
    );
  }

  const handle = current ? `@${current.username || current.title || current.id}` : '@—';
  const initial = (current?.username || current?.title || 'T').slice(0, 1).toUpperCase();
  const members = current?.memberCount ?? data?.channel?.memberCount ?? data?.channel?.members ?? 0;

  return (
    <section className="flex items-center gap-3.5">
      <ChannelAvatar source={current?.source} initial={initial} className="h-12 w-12 rounded-xl text-lg" />
      <div className="min-w-0">
        {/* A div, not an h1 — the top bar already owns the page's single <h1> (route title). */}
        <div className="truncate text-xl font-medium tracking-tight">{handle}</div>
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
          <span>Telegram{members > 0 ? ` · ${fmt.num(members)} подписчиков` : ''}</span>
          {fresh && (
            <>
              <span aria-hidden="true">·</span>
              <span
                className={fresh.stale ? 'text-ember' : undefined}
                title={fresh.stale ? 'Данные устарели — последний сбор был давно' : undefined}
              >
                {fresh.label}
              </span>
              <MetricInfo def={METRIC_DEFS.freshness} />
            </>
          )}
        </p>
        {current && current.source === 'collector' && (
          <div className="mt-1">
            <SourceStatus channelId={current.id} source={current.source} compact />
          </div>
        )}
      </div>
    </section>
  );
}
