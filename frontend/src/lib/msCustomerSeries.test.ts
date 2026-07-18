import { describe, expect, it } from 'vitest';
import {
  bucketCustomerDays,
  customerMetricTotal,
  customerMetricValues,
  densifyCustomerDays,
  type MsCustomerDay,
} from '@/lib/msCustomerSeries';

const rows: MsCustomerDay[] = [
  { day: '2026-07-01', new_orders: 2, repeat_orders: 1, sum_new: 200, sum_repeat: 100 },
  { day: '2026-07-03', new_orders: 0, repeat_orders: 2, sum_new: 0, sum_repeat: 500 },
];

describe('MoySklad customer series', () => {
  it('densifies archive days with honest flow zeros', () => {
    const dense = densifyCustomerDays(rows, { days: 30, from: '2026-07-01', to: '2026-07-03' });
    expect(dense).toHaveLength(3);
    expect(dense[1]).toEqual({ day: '2026-07-02', new_orders: 0, repeat_orders: 0, sum_new: 0, sum_repeat: 0 });
  });

  it('derives bucket share from sums rather than averaging daily shares', () => {
    const bucket = bucketCustomerDays(rows, 'month')[0];
    expect(bucket).toMatchObject({ new_orders: 2, repeat_orders: 3, sum_new: 200, sum_repeat: 600 });
    expect(customerMetricValues(bucket, 'repeatShare').primary).toBe(75);
  });

  it('keeps repeat share undefined for an empty bucket', () => {
    const empty: MsCustomerDay = { day: '2026-07-02', new_orders: 0, repeat_orders: 0, sum_new: 0, sum_repeat: 0 };
    expect(customerMetricValues(empty, 'repeatShare')).toEqual({ primary: null, repeat: null });
  });

  it('computes window totals from underlying sums', () => {
    expect(customerMetricTotal(rows, 'orders')).toEqual({ value: 5, newValue: 2, repeatValue: 3 });
    expect(customerMetricTotal(rows, 'revenue')).toEqual({ value: 800, newValue: 200, repeatValue: 600 });
    expect(customerMetricTotal(rows, 'repeatShare').value).toBe(75);
    expect(customerMetricTotal([], 'repeatShare').value).toBeNull();
  });
});
