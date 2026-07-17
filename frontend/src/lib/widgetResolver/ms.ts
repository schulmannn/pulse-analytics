// Резолвер-семейство МойСклада: три series-метрики (выручка / заказы / средний чек) из уже
// СЕРВЕР-НАРЕЗАННОГО /api/ms/summary (ctx.ms.summary кладёт useMsWidgetData). В отличие от IG,
// окно здесь не режется на клиенте — hook запрашивает summary ровно под период виджета, поэтому
// резолвер только мапит серии и лепит хедлайн. Рубли форматируем прямо в out.value (₽); оси и
// тултипы получают ₽ через unit 'currency' (widgetRender.unitFormat). Ghost-сравнение отдаём
// generic-слою resolveWidgetMetric (moving_average/same_weekday работают от out.series).

import { fmt } from '@/lib/format';
import type { WidgetMetricResolver, WidgetSeriesPoint } from '@/lib/widgetResolver/types';

const rub = (n: number) => `${fmt.short(n)} ₽`;

export const resolveMsMetric: WidgetMetricResolver = (metric, _config, ctx, out) => {
  const summary = ctx.ms?.summary;
  if (!summary) return { ...out, empty: true };

  if (metric.id === 'ms.revenue') {
    const points: WidgetSeriesPoint[] = summary.revenue.series.map((p) => ({ date: p.day, value: p.value }));
    if (!points.length) return { ...out, empty: true };
    out.series = points;
    out.valueRaw = summary.revenue.total;
    out.value = rub(summary.revenue.total);
    return out;
  }

  if (metric.id === 'ms.orders') {
    const points: WidgetSeriesPoint[] = summary.orders.series.map((p) => ({ date: p.day, value: p.count }));
    if (!points.length) return { ...out, empty: true };
    out.series = points;
    out.valueRaw = summary.orders.totalCount;
    out.value = fmt.num(summary.orders.totalCount);
    return out;
  }

  if (metric.id === 'ms.avgCheck') {
    // Средний чек существует только у дней С заказами: деление на ноль дало бы
    // «ноль-которого-не-было», поэтому пустые дни в серию не входят (см. included в каталоге).
    const points: WidgetSeriesPoint[] = summary.orders.series
      .filter((p) => p.count > 0)
      .map((p) => ({ date: p.day, value: Math.round(p.sum / p.count) }));
    if (!points.length || summary.orders.totalCount === 0) return { ...out, empty: true };
    const avg = summary.orders.totalSum / summary.orders.totalCount;
    out.series = points;
    out.valueRaw = avg;
    out.value = rub(avg);
    return out;
  }

  return { ...out, empty: true };
};
