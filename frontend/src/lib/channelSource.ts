import type { Channel } from '@/api/schemas';

/**
 * Channels eligible as a pinned data source for a metric of the given network — mirrors the source
 * switcher (DashboardLayout `filtered`): Telegram excludes НЕ-телеграмные standalone-источники
 * (`source === 'ig'` и `source === 'ms'` — у них нет Telegram-стороны), and Instagram offers ONLY
 * channels with a linked Instagram account (`ig_connected`). Keeping this in one place stops the
 * widget editor from listing чужие каналы under a metric (and vice-versa). Callers narrow the
 * metric's network to 'tg' | 'ig' | 'ms' first.
 */
export function channelsForSource(channels: Channel[], source: 'tg' | 'ig' | 'ms'): Channel[] {
  if (source === 'ig') return channels.filter((c) => !!c.ig_connected);
  if (source === 'ms') return channels.filter((c) => c.source === 'ms');
  return channels.filter((c) => c.source !== 'ig' && c.source !== 'ms');
}

/** Whether a channel id is a valid pinned source for the given network (used to spot a stale pin —
 *  e.g. a Telegram channel left on an Instagram widget from before source-aware filtering). */
export function isEligibleSource(channels: Channel[], source: 'tg' | 'ig' | 'ms', id: number): boolean {
  return channelsForSource(channels, source).some((c) => c.id === id);
}

/**
 * Канал для виджета ГЛАВНОЙ без явного «Источника». Канон доски: карточка хранит собственную
 * identity и НЕ следует глобальному свитчеру — тот может указывать на канал другой сети
 * (например, МойСклад), и TG/IG-виджет читал бы пустоту под чужой подписью. Резолв:
 * запомненный канал СЕТИ ВИДЖЕТА (per-network memory свитчера), если он ещё существует и
 * подходит сети; иначе первый подходящий канал; иначе null (данных этой сети нет вовсе —
 * честная пустота с прежним поведением).
 */
export function resolveHomeSourceChannel(
  channels: Channel[],
  source: 'tg' | 'ig' | 'ms',
  remembered: number | null,
): number | null {
  const eligible = channelsForSource(channels, source);
  if (remembered != null && eligible.some((c) => c.id === remembered)) return remembered;
  return eligible.length ? eligible[0]!.id : null;
}
