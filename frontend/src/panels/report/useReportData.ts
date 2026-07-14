import { useMemo } from 'react';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import { deriveKpis, filledDailySeries, sparseDailySeries } from '@/lib/kpiDerive';
import type { DailySeries, DrillKey, PostMetricField } from '@/lib/kpiDerive';
import { DAY_MS, buildWeeklyTable } from '@/lib/reportTables';
import { fmt } from '@/lib/format';

export interface ChartSpec {
  series: DailySeries;
  valueFmt: (n: number) => string;
  zeroBase: boolean;
  label: string;
  drill: DrillKey;
}

/**
 * Shared read-model for a report document: fetches the source's TG data under the ambient
 * ChannelScope, derives the KPI ledger + daily series + weekly table, and exposes the period
 * state. Both the desktop (read/edit) and mobile (always-inline) documents render from this —
 * the composition is pure of any fetch, so the two surfaces stay data-identical. No editing
 * concern lives here; the chrome (rename, schedule, block edits) is per-surface.
 */
export function useReportData() {
  const { days, setDays, range, setRange, inRange } = usePeriod();
  const { data, isPending, isError, error } = useTgFull(days, { windowPair: true });
  const { data: history } = useHistory(730);
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();

  const derived = useMemo(
    () => deriveKpis(data, history, channelsData, channelId, days, range, inRange),
    [data, history, channelsData, channelId, days, range, inRange],
  );
  const weekly = useMemo(() => buildWeeklyTable(history?.rows ?? []), [history]);

  const winTo = range ? range.to : Date.now();
  const winFrom = range ? range.from : days > 0 ? winTo - (days - 1) * DAY_MS : null;
  const dailyFor = (field: PostMetricField): DailySeries =>
    winFrom != null && (winTo - winFrom) / DAY_MS <= 366
      ? filledDailySeries(derived.normPosts, field, winFrom, winTo)
      : sparseDailySeries(derived.normPosts, field);

  const viewsSeries = dailyFor('reach');
  const reactionsSeries = dailyFor('likes');
  const { drillMeta, periodLabel, subsSpark } = derived;

  // Chart / big-number metric → its daily series + KPI headline (reconciles with the ledger).
  const chartSpec = (metric: string): ChartSpec => {
    switch (metric) {
      case 'subscribers':
        return { series: subsSpark, valueFmt: fmt.num, zeroBase: false, label: 'Подписчики по дням', drill: 'subscribers' };
      case 'reactions':
        return { series: dailyFor('likes'), valueFmt: fmt.short, zeroBase: true, label: 'Реакции по дням', drill: 'reactions' };
      case 'forwards':
        return { series: dailyFor('shares'), valueFmt: fmt.short, zeroBase: true, label: 'Репосты по дням', drill: 'forwards' };
      case 'views':
      default:
        return { series: dailyFor('reach'), valueFmt: fmt.short, zeroBase: true, label: 'Просмотры по дням', drill: 'views' };
    }
  };

  const channels = channelsData?.channels ?? [];
  const current = channels.find((c) => c.id === channelId);
  const channelName = String(current?.username || current?.title || current?.id || '');
  const channelLabel = current?.username
    ? `@${current.username}`
    : current?.title || (current?.id != null ? `Источник #${current.id}` : 'Источник не выбран');
  const rangeLabel = range ? `${fmt.day(range.from)} – ${fmt.day(range.to)}` : null;

  return {
    status: isPending ? ('pending' as const) : isError ? ('error' as const) : ('ready' as const),
    error,
    days,
    setDays,
    range,
    setRange,
    channels,
    channelId,
    channelName,
    channelLabel,
    drillMeta,
    subsSpark,
    viewsSeries,
    reactionsSeries,
    weekly,
    chartSpec,
    periodLabel,
    rangeLabel,
  };
}

export type ReportData = ReturnType<typeof useReportData>;
