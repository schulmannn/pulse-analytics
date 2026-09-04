import { parseMsChannelIds } from '@/lib/msMetricUrlState';

/** Account-synced filter identity. MoySklad sales-channel ids belong to one selected source, so the
    source id is part of the key and can never leak a selection into another connection. */
export function msChannelFilterKey(channelId: number | null): string {
  return `ms-channels:${channelId ?? 'none'}`;
}

/** Saved/account input follows the same bounded UUID contract as the public URL. */
export function normalizeMsChannelFilter(ids: readonly string[]): string[] {
  return parseMsChannelIds(ids.join(','));
}

export function sameMsChannelFilter(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}
