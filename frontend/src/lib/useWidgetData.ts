// The bridge between the metric engine and React data — `useWidgetData(config)` assembles a
// DataContext from the already-cached query hooks (no new fetches; TanStack Query dedupes) and runs
// the pure resolver. It is the ONE place React data meets the resolver, so the WidgetRenderer stays
// data-source-agnostic. Source pinning (config.source) is applied by the mount wrapping the widget in
// a ChannelScope — the query hooks below then read the pinned channel automatically.

import { useMemo } from 'react';
import { useChannels, useHistory, useTgFull, useTgGraphs } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { DEFAULT_WIDGET_DAYS, widgetPeriodValue } from '@/lib/period';
import { resolveWidgetMetric, type DataContext, type WidgetResult } from '@/lib/resolveWidgetMetric';
import type { WidgetConfig } from '@/lib/widgetConfig';
import { useWidgetInView } from '@/lib/widgetViewport';

export function useWidgetData(config: WidgetConfig): { result: WidgetResult; isLoading: boolean } {
  const days = config.period ?? DEFAULT_WIDGET_DAYS;
  // The widget's window (preset only — per-widget custom ranges are a later follow-up, like the
  // rest of the app). Memoized on `days` so `inRange`'s identity is stable across re-renders.
  const period = useMemo(() => widgetPeriodValue(days), [days]);

  // Прогрессивная загрузка Главной: карточка ниже вьюпорта (ChartSection ставит Provider для
  // homeKey-карточек) не запускает запросы, пока не приблизится. Вне Главной контекст = true, всё
  // как раньше. queryKey не меняется — офскрин-карточка просто держит query disabled (isPending →
  // скелетон, который всё равно не виден).
  const inView = useWidgetInView();

  // Cached query payloads (windowPair fetches enough history for the comparison/ghost baseline,
  // matching the metric page). Hooks run unconditionally — an IG metric simply resolves to empty
  // until S11 wires the IG paths, without over-thinking conditional fetching here.
  const fullQ = useTgFull(days, { windowPair: true, enabled: inView });
  const historyQ = useHistory(730, { enabled: inView });
  const graphsQ = useTgGraphs({ enabled: inView });
  const channelsQ = useChannels();
  const { channelId } = useSelectedChannel();
  const full = fullQ.data;
  const history = historyQ.data;
  const graphs = graphsQ.data;
  const channels = channelsQ.data;

  const result = useMemo(() => {
    const ctx: DataContext = {
      now: Date.now(),
      days,
      range: null,
      inRange: period.inRange,
      tg: { full, history, channels, graphs, channelId },
    };
    return resolveWidgetMetric(config, ctx);
    // Date.now() is read inside deliberately (a fresh resolve on data/period change uses the
    // current instant; it isn't a dependency — the window rounds to day buckets anyway).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, days, period, full, history, channels, graphs, channelId]);

  // Loading = a channel is selected AND the two universal TG sources (posts + subscriber archive)
  // haven't arrived yet. So the card shows a shaped skeleton instead of flashing «Нет данных» before
  // data loads. When no channel is selected the queries are disabled (perpetually pending) — that is
  // a genuine empty state, not loading, so gate on channelId to avoid a forever-skeleton.
  const isLoading = channelId != null && (fullQ.isPending || historyQ.isPending);
  return { result, isLoading };
}
