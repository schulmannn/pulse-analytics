// The IG counterpart of useWidgetData — assembles an Instagram DataContext from the cached IG query
// hooks (windowed to the widget's period by the shared IG window plan, like useIgData) and runs the resolver. Kept
// separate so a TG widget never mounts the IG queries and vice-versa: ConfigWidget picks the TG or
// IG body by metric.source, so each hook set runs unconditionally within its own component.

import { useMemo } from 'react';
import { useIgBreakdowns, useIgHistory, useIgInsights, useIgOnline, useIgProfile } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { igWindowPlan } from '@/lib/igArchiveWindow';
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

  // Тот же план окна, что у useIgData (lib/igArchiveWindow): пресеты 7/30/90 — живые агрегаты,
  // «Всё» — архив ig_daily без 90-дневного потолка (OD-13). Живые инсайты запрашиваются ТОЛЬКО
  // для живого окна: архивному окну они не нужны, квота Graph не тратится.
  const plan = igWindowPlan({ days, range: null, now: Date.now() });
  const live = plan.mode === 'live';

  const profileQ = useIgProfile(inView);
  const insightsQ = useIgInsights(plan.insDays, inView && live);
  const breakdownsQ = useIgBreakdowns(plan.timeframe, inView);
  const onlineQ = useIgOnline(inView);
  const historyQ = useIgHistory(inView);
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
  // Гейт — по тем запросам, из которых окно считается: живое — профиль + инсайты, архивное —
  // профиль + архив (isLoading: выключенный в демо архив не висит вечной загрузкой).
  const second = live ? insightsQ : historyQ;
  const state = widgetDataStateOf({
    channelId,
    pending: [profileQ.isPending, live ? insightsQ.isPending : historyQ.isLoading],
    errored: [profileQ.isError, second.isError],
    fetching: [profileQ.isFetching, second.isFetching],
  });
  const retry = () => {
    void profileQ.refetch();
    void second.refetch();
  };
  return { result, ...state, retry };
}
