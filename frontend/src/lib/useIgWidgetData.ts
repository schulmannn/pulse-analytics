// The IG counterpart of useWidgetData — assembles an Instagram DataContext from the cached IG query
// hooks (windowed to the widget's period, capped ~90d like useIgData) and runs the resolver. Kept
// separate so a TG widget never mounts the IG queries and vice-versa: ConfigWidget picks the TG or
// IG body by metric.source, so each hook set runs unconditionally within its own component.

import { useMemo } from 'react';
import { useIgBreakdowns, useIgHistory, useIgInsights, useIgOnline, useIgProfile } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { DEFAULT_WIDGET_DAYS, widgetPeriodValue } from '@/lib/period';
import { resolveWidgetMetric, type DataContext, type WidgetResult } from '@/lib/resolveWidgetMetric';
import type { WidgetConfig } from '@/lib/widgetConfig';

export function useIgWidgetData(config: WidgetConfig): { result: WidgetResult; isLoading: boolean } {
  const days = config.period ?? DEFAULT_WIDGET_DAYS;
  const period = useMemo(() => widgetPeriodValue(days), [days]);

  // Match useIgData's param mapping: insights day-count (capped 90) + the breakdowns timeframe bucket.
  const insDays = days > 0 ? Math.min(days, 90) : 90;
  const timeframe = days === 7 ? 'last_14_days' : days === 90 || days === 0 ? 'last_90_days' : 'last_30_days';

  const profileQ = useIgProfile();
  const insightsQ = useIgInsights(insDays);
  const breakdownsQ = useIgBreakdowns(timeframe);
  const onlineQ = useIgOnline();
  const historyQ = useIgHistory();
  const { channelId } = useSelectedChannel();

  const result = useMemo(() => {
    const ctx: DataContext = {
      now: Date.now(),
      days,
      range: null,
      inRange: period.inRange,
      ig: {
        profile: profileQ.data,
        insights: insightsQ.data,
        breakdowns: breakdownsQ.data,
        online: onlineQ.data,
        history: historyQ.data,
      },
    };
    return resolveWidgetMetric(config, ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, days, period, profileQ.data, insightsQ.data, breakdownsQ.data, onlineQ.data, historyQ.data]);

  // Loading = a channel is selected AND the core IG sources (profile + insights) are still pending
  // → show a shaped skeleton instead of flashing «Нет данных». channelId gate avoids a forever
  // skeleton when the queries are disabled (no channel = a real empty state, not loading).
  const isLoading = channelId != null && (profileQ.isPending || insightsQ.isPending);
  return { result, isLoading };
}
