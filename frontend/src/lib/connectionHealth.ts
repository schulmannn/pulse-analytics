import type { Freshness } from '@/lib/freshness';

/**
 * The single source of truth for the Overview data-health banner: given the selected channel's
 * source, the managed-QR session's `connection_state` (only meaningful for source='qr'), and the
 * history freshness, decide WHETHER to warn, in what TONE, with what COPY and deep link. Kept pure and
 * exhaustively unit-tested so copy/tone/links are deterministic and never drift from the backend
 * contract.
 *
 * Contract (see server/lib/tgSessionStatus.js): only `connection_state === 'reauth_required'` means
 * the stored Telegram session actually died and a re-login is required. `degraded` is transient —
 * collection retries on its own, so we must NOT tell the user to reconnect. Any other/unknown state
 * (or an absent one) is treated as a live session; then only genuinely stale history warrants a
 * warning. Freshness alone NEVER implies revocation — a stale QR channel that is still `connected`
 * gets an honest "check the connection" nudge, not a false "session invalid".
 */

export type HealthTone = 'error' | 'warn';

export interface HealthBanner {
  tone: HealthTone;
  message: string;
  cta: { label: string; to: string } | null;
}

export interface HealthInput {
  /** Selected channel source: 'qr' | 'collector' | 'central' | 'ig' | … (undefined while loading). */
  source?: string | null;
  /** Public `connection_state` from GET /api/tg/qr/status — pass null unless the source is managed
   *  (source === 'qr', or source === 'central' when the caller owns the central channel). */
  connectionState?: string | null;
  /** History freshness (from freshness()) — null when the channel has no archive yet. */
  fresh: Freshness | null;
  /** `central_owner` from GET /api/tg/qr/status — true only when source === 'central' AND the caller
   *  owns it (its managed session is now the collector). Non-owners fall back to generic behavior. */
  centralOwner?: boolean | null;
}

export interface SidebarHealth {
  tone: 'ok' | 'warn' | 'error';
  label: string;
}

// Deep links are exact by design — the /connect page reads these query params to preselect the
// source, open the right tab, and (for reconnect) render the focused reconnect callout.
const RECONNECT_LINK = { label: 'Переподключить Telegram →', to: '/connect?source=telegram&tab=qr&action=reconnect' };
const QR_STATUS_LINK = { label: 'Проверить подключение →', to: '/connect?source=telegram&tab=qr' };
const QR_REFRESH_LINK = { label: 'Обновить подключение →', to: '/connect?source=telegram&tab=qr&action=reconnect' };
const AGENT_LINK = { label: 'Проверить агента →', to: '/connect?source=telegram&tab=agent' };

/** Managed-session repair banner, shared by source='qr' and an owner's source='central' — both are
 *  now collected through a stored, repairable Telegram session with identical semantics. */
function managedRepairBanner(connectionState: string | null | undefined, stale: boolean, lastLabel: string | null): HealthBanner | null {
  // Explicit revocation wins over everything, including a still-fresh archive — the session is dead
  // NOW, so waiting for the history to age would leave the user staring at silently frozen numbers.
  if (connectionState === 'reauth_required') {
    return {
      tone: 'error',
      message: 'Сессия Telegram недействительна — новые данные не поступают.',
      cta: RECONNECT_LINK,
    };
  }
  // Transient outage: honest, reassuring, and explicitly NOT a reconnect ask.
  if (connectionState === 'degraded') {
    return {
      tone: 'warn',
      message: 'Telegram временно недоступен — сбор возобновится автоматически, переподключение не требуется.',
      cta: QR_STATUS_LINK,
    };
  }
  // Live (or unknown/disconnected) session but the archive has aged — an honest freshness nudge with a
  // direct update/reconnect link, never a claim that the session is revoked.
  if (stale) {
    return {
      tone: 'warn',
      message: `Данные устарели — последний сбор ${lastLabel}. Проверьте подключение Telegram.`,
      cta: QR_REFRESH_LINK,
    };
  }
  return null;
}

/** Is this a source collected through a repairable, owner-held session? Managed QR always is; the
 *  central channel is only when the caller owns it (then its session IS the collector). */
function isManagedSource(source?: string | null, centralOwner?: boolean | null): boolean {
  return source === 'qr' || (source === 'central' && !!centralOwner);
}

export function overviewHealthBanner({ source, connectionState, fresh, centralOwner }: HealthInput): HealthBanner | null {
  const stale = fresh?.stale ?? false;
  const lastLabel = fresh?.label ?? null;

  if (isManagedSource(source, centralOwner)) return managedRepairBanner(connectionState, stale, lastLabel);

  // Non-managed sources have no repairable session — only stale history warrants a banner. (A central
  // channel the caller does NOT own also lands here: generic stale notice, no repair CTA.)
  if (!stale) return null;

  if (source === 'collector') {
    return {
      tone: 'warn',
      message: `Данные устарели — последний сбор ${lastLabel}. Проверьте, что collector-агент запущен.`,
      cta: AGENT_LINK,
    };
  }

  // Central (managed MTProto) and any other source: a generic stale notice. No CTA — the user cannot
  // repair a centrally-managed session, and there is no stored QR session to re-scan here.
  return {
    tone: 'warn',
    message: `Данные устарели — последний сбор ${lastLabel}.`,
    cta: null,
  };
}

/** Compact source health for the persistent desktop sidebar. */
export function sidebarHealth({ source, connectionState, fresh, centralOwner }: HealthInput): SidebarHealth | null {
  const managed = isManagedSource(source, centralOwner);
  if (managed && connectionState === 'reauth_required') {
    return { tone: 'error', label: 'нужно переподключить' };
  }
  if (managed && connectionState === 'degraded') {
    return { tone: 'warn', label: 'сбор временно недоступен' };
  }
  if (!fresh) return null;
  return {
    tone: fresh.stale ? 'warn' : 'ok',
    label: `обновлено ${fresh.label}`,
  };
}
