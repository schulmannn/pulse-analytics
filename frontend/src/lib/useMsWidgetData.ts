// МС-аналог useIgWidgetData: собирает MsDataContext из кэшируемого useMsSummary (окно = период
// виджета, сервер режет сам) и гонит резолвер. Отдельный hook-файл по тому же канону изоляции:
// ConfigWidget выбирает тело по metric.source, и МС-виджет никогда не монтирует TG/IG-запросы
// (и наоборот).

import { useMemo } from 'react';
import { useMsSummary } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { DEFAULT_WIDGET_DAYS, widgetPeriodValue } from '@/lib/period';
import { resolveWidgetMetric, type DataContext, type WidgetResult } from '@/lib/resolveWidgetMetric';
import type { WidgetConfig } from '@/lib/widgetConfig';

export function useMsWidgetData(config: WidgetConfig): { result: WidgetResult; isLoading: boolean } {
  const days = config.period ?? DEFAULT_WIDGET_DAYS;
  const period = useMemo(() => widgetPeriodValue(days), [days]);
  // Home-виджет несёт СВОЙ пресет-период (без произвольного диапазона топбара) — сериализуем как
  // preset-only MsPeriod, чтобы поведение Главной осталось прежним (канон #5: пресеты стабильны).
  const summaryQ = useMsSummary({ days });
  const { channelId } = useSelectedChannel();

  const result = useMemo(() => {
    const ctx: DataContext = {
      now: Date.now(),
      days,
      range: null,
      inRange: period.inRange,
      ms: { summary: summaryQ.data },
    };
    return resolveWidgetMetric(config, ctx);
  }, [config, days, period, summaryQ.data]);

  // Как в IG-хуке: скелет только пока канал выбран и summary реально грузится; отключённый запрос
  // (нет канала) — честная пустота, а не вечный скелет.
  const isLoading = channelId != null && summaryQ.isPending;
  return { result, isLoading };
}
