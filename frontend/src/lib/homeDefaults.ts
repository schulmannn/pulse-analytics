import { networkByKey, type ChannelSourceLike } from '@/lib/networks';

/** Frozen pre-redesign seed used only by the deferred mobile surface. */
export const HOME_LEGACY_DEFAULT_KEYS = ['week', 'kpi', 'growth', 'ig-reach', 'top-posts'] as const;

/**
 * DEFAULT HOME COMPOSITION — the ordered registry keys that «Собрать по умолчанию» seeds for a
 * reader who hasn't pinned anything yet. Kept as a PURE function of the available channels/networks
 * so it's unit-testable and never touches storage: the caller passes the result to setHomeBlocks.
 *
 * Shape (the desktop empty-state promise): a headline KPI band first (full), then an explanation +
 * trends pair (Неделя канала + Рост подписчиков, half/half), then editorial content (Лучшие
 * публикации, full). An Instagram reach card is inserted ONLY when a connected IG source exists, so
 * a Telegram-only workspace never seeds a permanently-empty IG widget. A workspace with NO Telegram
 * side (IG-only) seeds an all-Instagram default instead.
 *
 * Availability mirrors the network registry predicates (lib/networks): a Telegram source is any
 * channel that isn't a standalone IG account; an Instagram source is any channel with a linked IG
 * account (`ig_connected`). This never MIGRATES an existing board — it only builds the seed set.
 */
export function defaultHomeKeys(channels: readonly ChannelSourceLike[] = []): string[] {
  const hasTg = channels.some(networkByKey('tg').hasChannel);
  const hasIg = channels.some(networkByKey('ig').hasChannel);
  const hasMs = channels.some(networkByKey('ms').hasChannel);

  // МС-only workspace: в HOME_REGISTRY пока нет кураторских карточек склада — честная пустая доска
  // (Home покажет CTA добавления, каталог предлагает МС-метрики) вместо сева мёртвых TG-виджетов.
  if (!hasTg && !hasIg && hasMs) return [];

  // IG-only workspace (a standalone Instagram account, no Telegram side): an all-IG default so the
  // board isn't seeded with Telegram widgets that can never resolve a source.
  if (!hasTg && hasIg) return ['ig-kpi', 'ig-week', 'ig-reach'];

  // Telegram-first default (also the fallback when no channels have loaded yet): KPI band →
  // explanation + trends (half/half) → optional IG reach → editorial content.
  const keys = ['kpi', 'week', 'growth'];
  if (hasIg) keys.push('ig-reach');
  keys.push('top-posts');
  return keys;
}
