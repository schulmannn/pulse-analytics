// Резолвер-семейство Яндекс.Метрики: три series-метрики (визиты / посетители / просмотры
// страниц) из уже СЕРВЕР-НАРЕЗАННОГО /api/ym/summary (ctx.ym.summary кладёт useYmWidgetData) —
// зеркало резолвера МойСклада: окно не режется на клиенте, резолвер только мапит серии и лепит
// хедлайн. Хедлайн «Посетителей» — сумма дневных уникальных (канон подписи «сумма по дням» —
// included в каталоге). Ghost-сравнение отдаём generic-слою resolveWidgetMetric.

import { fmt } from '@/lib/format';
import type { WidgetMetricResolver, WidgetSeriesPoint } from '@/lib/widgetResolver/types';

export const resolveYmMetric: WidgetMetricResolver = (metric, _config, ctx, out) => {
  const summary = ctx.ym?.summary;
  if (!summary) return { ...out, empty: true };

  const block =
    metric.id === 'ym.visits'
      ? summary.visits
      : metric.id === 'ym.users'
        ? summary.users
        : metric.id === 'ym.pageviews'
          ? summary.pageviews
          : null;
  if (!block) return { ...out, empty: true };

  const points: WidgetSeriesPoint[] = block.series.map((p) => ({ date: p.day, value: p.value }));
  if (!points.length) return { ...out, empty: true };
  out.series = points;
  out.valueRaw = block.total;
  out.value = fmt.num(block.total);
  return out;
};
