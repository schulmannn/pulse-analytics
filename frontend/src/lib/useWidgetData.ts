// The bridge between the metric engine and React data — `useWidgetData(config)` assembles a
// DataContext from the already-cached query hooks (no new fetches; TanStack Query dedupes) and runs
// the pure resolver. It is the ONE place React data meets the resolver, so the WidgetRenderer stays
// data-source-agnostic. Source pinning (config.source) is applied by the mount wrapping the widget in
// a ChannelScope — the query hooks below then read the pinned channel automatically.

import { useMemo } from 'react';
import { useChannels, useHistory, useTgFull, useTgGraphs } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { DEFAULT_WIDGET_DAYS, widgetPeriodValue } from '@/lib/period';
import { resolveWidgetMetric, type DataContext } from '@/lib/resolveWidgetMetric';
import type { WidgetConfig } from '@/lib/widgetConfig';
import { widgetDataStateOf, type WidgetDataState } from '@/lib/widgetDataState';
import { useWidgetInView } from '@/lib/widgetViewport';

// Ошибка ≠ пустота. Если запрос упал, `isPending` становится false, данные остаются undefined,
// резолвер честно отдаёт `empty`, и карточка печатала «Нет данных за период» — то есть выдавала
// сбой сети за достоверный ответ «за этот период пусто». Отдаём ошибку отдельным флагом и даём
// повтор: гейтим по ТЕМ ЖЕ запросам, что и `isLoading`, чтобы состояния были взаимоисключающими.
export function useWidgetData(config: WidgetConfig): WidgetDataState {
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
  }, [config, days, period, full, history, channels, graphs, channelId]);

  // Loading = a channel is selected AND the two universal TG sources (posts + subscriber archive)
  // haven't arrived yet. So the card shows a shaped skeleton instead of flashing «Нет данных» before
  // data loads. When no channel is selected the queries are disabled (perpetually pending) — that is
  // a genuine empty state, not loading, so gate on channelId to avoid a forever-skeleton.
  const state = widgetDataStateOf({
    channelId,
    pending: [fullQ.isPending, historyQ.isPending],
    errored: [fullQ.isError, historyQ.isError],
    fetching: [fullQ.isFetching, historyQ.isFetching],
  });
  const retry = () => {
    void fullQ.refetch();
    void historyQ.refetch();
  };
  return { result, ...state, retry };
}
