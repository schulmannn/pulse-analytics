import type { Channel } from '@/api/schemas';

/**
 * Channels eligible as a pinned data source for a metric of the given network — mirrors the source
 * switcher (DashboardLayout `filtered`): Telegram excludes standalone Instagram sources
 * (`source === 'ig'`, which have no Telegram side), and Instagram offers ONLY channels with a linked
 * Instagram account (`ig_connected`). Keeping this in one place stops the widget editor from listing
 * Telegram channels under an Instagram metric (and vice-versa). Callers narrow the metric's network
 * to 'tg' | 'ig' first (a catalogue metric is always one of the two).
 */
export function channelsForSource(channels: Channel[], source: 'tg' | 'ig'): Channel[] {
  return source === 'ig'
    ? channels.filter((c) => !!c.ig_connected)
    : channels.filter((c) => c.source !== 'ig');
}

/** Whether a channel id is a valid pinned source for the given network (used to spot a stale pin —
 *  e.g. a Telegram channel left on an Instagram widget from before source-aware filtering). */
export function isEligibleSource(channels: Channel[], source: 'tg' | 'ig', id: number): boolean {
  return channelsForSource(channels, source).some((c) => c.id === id);
}
