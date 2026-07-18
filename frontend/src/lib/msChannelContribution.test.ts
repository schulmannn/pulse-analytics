import { describe, expect, it } from 'vitest';
import {
  buildMsChannelContributionItems,
  msChannelContributionDelta,
  sortMsChannelContributionItems,
  type MsSalesByChannelData,
} from './msChannelContribution';

const current: MsSalesByChannelData = {
  total_orders: 9,
  no_channel_orders: 2,
  no_channel_sum: 200,
  rows: [
    { sales_channel_id: 'steady', name: 'Стабильный', type: null, orders: 5, sum: 500 },
    { sales_channel_id: 'new', name: 'Новый', type: null, orders: 2, sum: 400 },
  ],
};

const previous: MsSalesByChannelData = {
  total_orders: 8,
  no_channel_orders: 1,
  no_channel_sum: 50,
  rows: [
    { sales_channel_id: 'steady', name: 'Стабильный', type: null, orders: 5, sum: 450 },
    { sales_channel_id: 'gone', name: 'Исчезнувший', type: null, orders: 2, sum: 700 },
  ],
};

describe('MoySklad channel contribution', () => {
  it('keeps new, disappeared and unassigned rows so signed deltas reconcile to the total', () => {
    const items = buildMsChannelContributionItems(current, previous);
    expect(items.map((item) => item.name)).toEqual(
      expect.arrayContaining(['Стабильный', 'Новый', 'Исчезнувший', 'Без канала']),
    );
    const revenueDelta = items.reduce((sum, item) => sum + (msChannelContributionDelta(item, 'revenue') ?? 0), 0);
    const ordersDelta = items.reduce((sum, item) => sum + (msChannelContributionDelta(item, 'orders') ?? 0), 0);
    expect(revenueDelta).toBe((500 + 400 + 200) - (450 + 700 + 50));
    expect(ordersDelta).toBe(current.total_orders - previous.total_orders);
  });

  it('ranks by absolute impact instead of hiding the largest decline', () => {
    const items = buildMsChannelContributionItems(current, previous);
    expect(sortMsChannelContributionItems(items, 'revenue', true)[0]?.name).toBe('Исчезнувший');
  });

  it('does not fabricate previous zeroes when comparison is unavailable', () => {
    const items = buildMsChannelContributionItems(current, null);
    expect(items.every((item) => msChannelContributionDelta(item, 'revenue') === null)).toBe(true);
    expect(items.every((item) => msChannelContributionDelta(item, 'orders') === null)).toBe(true);
  });
});
