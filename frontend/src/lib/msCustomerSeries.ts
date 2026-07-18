import { msDensifyWindow, type MsPeriod } from '@/lib/msPeriod';
import { dayToDate, localDayKey, strideEvery, type Grain } from '@/lib/msSeries';

export type MsCustomerMetric = 'orders' | 'revenue' | 'repeatShare';

export type MsCustomerDay = {
  day: string;
  new_orders: number;
  repeat_orders: number;
  sum_new: number;
  sum_repeat: number;
};

/** Densifies an archive-derived flow series. A day without orders is a real zero; the repeat
    share remains undefined later because its denominator is zero. */
export function densifyCustomerDays(series: MsCustomerDay[], period: MsPeriod): MsCustomerDay[] {
  const win = msDensifyWindow(period, series[0]?.day);
  if (!win) return series;
  const byDay = new Map(series.map((row) => [row.day, row]));
  const out: MsCustomerDay[] = [];
  for (const d = new Date(win.start); d <= win.end; d.setDate(d.getDate() + 1)) {
    const day = localDayKey(d);
    out.push(byDay.get(day) ?? { day, new_orders: 0, repeat_orders: 0, sum_new: 0, sum_repeat: 0 });
  }
  return out;
}

/** Week/month buckets sum the underlying counts and money. In particular repeat share is later
    derived from Σrepeat / Σtotal, never from an average of volatile daily percentages. */
export function bucketCustomerDays(points: MsCustomerDay[], grain: Grain): MsCustomerDay[] {
  if (grain === 'day') return points;
  const bucketKey = (day: string) => {
    if (grain === 'month') return `${day.slice(0, 7)}-01`;
    const d = dayToDate(day);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return localDayKey(d);
  };
  const buckets = new Map<string, MsCustomerDay>();
  for (const point of points) {
    const day = bucketKey(point.day);
    const bucket = buckets.get(day) ?? { day, new_orders: 0, repeat_orders: 0, sum_new: 0, sum_repeat: 0 };
    bucket.new_orders += point.new_orders;
    bucket.repeat_orders += point.repeat_orders;
    bucket.sum_new += point.sum_new;
    bucket.sum_repeat += point.sum_repeat;
    buckets.set(day, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function customerMetricValues(
  point: MsCustomerDay,
  metric: MsCustomerMetric,
): { primary: number | null; repeat: number | null } {
  if (metric === 'orders') return { primary: point.new_orders, repeat: point.repeat_orders };
  if (metric === 'revenue') return { primary: point.sum_new, repeat: point.sum_repeat };
  const total = point.sum_new + point.sum_repeat;
  return { primary: total > 0 ? (point.sum_repeat / total) * 100 : null, repeat: null };
}

export function customerMetricTotal(
  points: MsCustomerDay[],
  metric: MsCustomerMetric,
): { value: number | null; newValue: number; repeatValue: number } {
  const newValue = points.reduce(
    (total, point) => total + (metric === 'orders' ? point.new_orders : point.sum_new),
    0,
  );
  const repeatValue = points.reduce(
    (total, point) => total + (metric === 'orders' ? point.repeat_orders : point.sum_repeat),
    0,
  );
  if (metric !== 'repeatShare') return { value: newValue + repeatValue, newValue, repeatValue };
  const total = newValue + repeatValue;
  return { value: total > 0 ? (repeatValue / total) * 100 : null, newValue, repeatValue };
}

/** One aligned stride for both parallel series. */
export function customerPlotPoints(points: MsCustomerDay[], maxPoints: number): MsCustomerDay[] {
  return strideEvery(points, maxPoints);
}
