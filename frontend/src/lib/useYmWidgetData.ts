// ЯМ-аналог useMsWidgetData: собирает YmDataContext из кэшируемого useYmSummary (окно = период
// виджета, сервер режет сам) и гонит резолвер. Отдельный hook-файл по тому же канону изоляции:
// ConfigWidget выбирает тело по metric.source, и Метрика-виджет никогда не монтирует TG/IG/МС-
// запросы (и наоборот).

import { useMemo } from 'react';
import { useYmSummary } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { DEFAULT_WIDGET_DAYS, widgetPeriodValue } from '@/lib/period';
import { resolveWidgetMetric, type DataContext, type WidgetResult } from '@/lib/resolveWidgetMetric';
import type { WidgetConfig } from '@/lib/widgetConfig';
import { useWidgetInView } from '@/lib/widgetViewport';

export function useYmWidgetData(config: WidgetConfig): { result: WidgetResult; isLoading: boolean } {
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
  const isLoading = channelId != null && summaryQ.isPending;
  return { result, isLoading };
}
