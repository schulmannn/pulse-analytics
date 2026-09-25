// The IG counterpart of useWidgetData — assembles an Instagram DataContext from the cached IG query
// hooks (windowed to the widget's period, capped ~90d like useIgData) and runs the resolver. Kept
// separate so a TG widget never mounts the IG queries and vice-versa: ConfigWidget picks the TG or
// IG body by metric.source, so each hook set runs unconditionally within its own component.

import { useMemo } from 'react';
import { useIgBreakdowns, useIgHistory, useIgInsights, useIgOnline, useIgProfile } from '@/api/queries';
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
export function useIgWidgetData(config: WidgetConfig): WidgetDataState {
  const days = config.period ?? DEFAULT_WIDGET_DAYS;
  const period = useMemo(() => widgetPeriodValue(days), [days]);

  // Прогрессивная загрузка Главной (зеркало useWidgetData): офскрин-карточка держит запросы
  // disabled, пока не приблизится к вьюпорту. Вне Главной контекст = true — всё как раньше.
  const inView = useWidgetInView();

  // Match useIgData's param mapping: insights day-count (capped 90) + the breakdowns timeframe bucket.
  const insDays = days > 0 ? Math.min(days, 90) : 90;
  const timeframe = days === 7 ? 'last_14_days' : days === 90 || days === 0 ? 'last_90_days' : 'last_30_days';

  const profileQ = useIgProfile(inView);
  const insightsQ = useIgInsights(insDays, inView);
  const breakdownsQ = useIgBreakdowns(timeframe, inView);
  const onlineQ = useIgOnline(inView);
  const historyQ = useIgHistory(400, inView);
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
  }, [config, days, period, profileQ.data, insightsQ.data, breakdownsQ.data, onlineQ.data, historyQ.data]);

  // Loading = a channel is selected AND the core IG sources (profile + insights) are still pending
  // → show a shaped skeleton instead of flashing «Нет данных». channelId gate avoids a forever
  // skeleton when the queries are disabled (no channel = a real empty state, not loading).
  const state = widgetDataStateOf({
    channelId,
    pending: [profileQ.isPending, insightsQ.isPending],
    errored: [profileQ.isError, insightsQ.isError],
    fetching: [profileQ.isFetching, insightsQ.isFetching],
  });
  const retry = () => {
    void profileQ.refetch();
    void insightsQ.refetch();
  };
  return { result, ...state, retry };
}
