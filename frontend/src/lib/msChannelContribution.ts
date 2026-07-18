export type MsChannelContributionMetric = 'revenue' | 'orders';

export type MsSalesChannelRow = {
  sales_channel_id: string;
  name: string | null;
  type: string | null;
  orders: number;
  sum: number;
};

export type MsSalesByChannelData = {
  rows: MsSalesChannelRow[];
  total_orders: number;
  no_channel_orders: number;
  no_channel_sum: number;
};

export type MsChannelContributionItem = {
  id: string;
  name: string;
  type: string | null;
  sum: number;
  orders: number;
  previousSum: number | null;
  previousOrders: number | null;
  synthetic: boolean;
};

export const MS_NO_CHANNEL_ID = '__ms_no_channel__';

/**
 * Joins the current and previous sales-channel snapshots without losing channels that disappeared
 * from the current window. `previous === null` means comparison is genuinely unavailable; it must
 * never be interpreted as a previous value of zero.
 */
export function buildMsChannelContributionItems(
  current: MsSalesByChannelData,
  previous: MsSalesByChannelData | null,
): MsChannelContributionItem[] {
  const currentById = new Map(current.rows.map((row) => [row.sales_channel_id, row]));
  const previousById = new Map((previous?.rows ?? []).map((row) => [row.sales_channel_id, row]));
  const ids = new Set([...currentById.keys(), ...previousById.keys()]);

  const rows = [...ids].map<MsChannelContributionItem>((id) => {
    const currentRow = currentById.get(id);
    const previousRow = previousById.get(id);
    return {
      id,
      name: currentRow?.name ?? previousRow?.name ?? 'Канал без имени',
      type: currentRow?.type ?? previousRow?.type ?? null,
      sum: currentRow?.sum ?? 0,
      orders: currentRow?.orders ?? 0,
      previousSum: previous ? (previousRow?.sum ?? 0) : null,
      previousOrders: previous ? (previousRow?.orders ?? 0) : null,
      synthetic: false,
    };
  });

  rows.push({
    id: MS_NO_CHANNEL_ID,
    name: 'Без канала',
    type: null,
    sum: current.no_channel_sum,
    orders: current.no_channel_orders,
    previousSum: previous ? previous.no_channel_sum : null,
    previousOrders: previous ? previous.no_channel_orders : null,
    synthetic: true,
  });
  return rows;
}

export function msChannelContributionCurrent(
  item: MsChannelContributionItem,
  metric: MsChannelContributionMetric,
): number {
  return metric === 'revenue' ? item.sum : item.orders;
}

export function msChannelContributionDelta(
  item: MsChannelContributionItem,
  metric: MsChannelContributionMetric,
): number | null {
  const previous = metric === 'revenue' ? item.previousSum : item.previousOrders;
  return previous == null ? null : msChannelContributionCurrent(item, metric) - previous;
}

/** Drivers are ranked by absolute impact; this keeps both growth and decline visible. */
export function sortMsChannelContributionItems(
  items: MsChannelContributionItem[],
  metric: MsChannelContributionMetric,
  comparable: boolean,
): MsChannelContributionItem[] {
  return [...items].sort((a, b) => {
    if (comparable) {
      const aDelta = Math.abs(msChannelContributionDelta(a, metric) ?? 0);
      const bDelta = Math.abs(msChannelContributionDelta(b, metric) ?? 0);
      if (aDelta !== bDelta) return bDelta - aDelta;
    }
    return msChannelContributionCurrent(b, metric) - msChannelContributionCurrent(a, metric)
      || a.name.localeCompare(b.name, 'ru');
  });
}
