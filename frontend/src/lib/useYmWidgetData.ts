// ЯМ-аналог useMsWidgetData: собирает YmDataContext из кэшируемого useYmSummary (окно = период
// виджета, сервер режет сам) и гонит резолвер. Отдельный hook-файл по тому же канону изоляции:
// ConfigWidget выбирает тело по metric.source, и Метрика-виджет никогда не монтирует TG/IG/МС-
// запросы (и наоборот).

import { useMemo } from 'react';
import { useYmSummary } from '@/api/queries';
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
export function useYmWidgetData(config: WidgetConfig): WidgetDataState {
  const days = config.period ?? DEFAULT_WIDGET_DAYS;
  const period = useMemo(() => widgetPeriodValue(days), [days]);
  // Прогрессивная загрузка Главной (зеркало useMsWidgetData): офскрин-карточка держит запрос
  // disabled, пока не приблизится к вьюпорту. Вне Главной контекст = true — всё как раньше.
  const inView = useWidgetInView();
  // Home-виджет несёт СВОЙ пресет-период (без произвольного диапазона топбара) — preset-only
  // MsPeriod, поведение Главной прежнее (канон #5: пресеты стабильны).
  const summaryQ = useYmSummary({ days }, { enabled: inView });
  const { channelId } = useSelectedChannel();

  const result = useMemo(() => {
    const ctx: DataContext = {
      now: Date.now(),
      days,
      range: null,
      inRange: period.inRange,
      ym: { summary: summaryQ.data },
    };
    return resolveWidgetMetric(config, ctx);
  }, [config, days, period, summaryQ.data]);

  // Как в МС-хуке: скелет только пока канал выбран и summary реально грузится; отключённый запрос
  // (нет канала) — честная пустота, а не вечный скелет.
  const state = widgetDataStateOf({
    channelId,
    pending: [summaryQ.isPending],
    errored: [summaryQ.isError],
    fetching: [summaryQ.isFetching],
  });
  const retry = () => {
    void summaryQ.refetch();
  };
  return { result, ...state, retry };
}
