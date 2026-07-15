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
  /** Public `connection_state` from GET /api/tg/qr/status — pass null unless source === 'qr'. */
  connectionState?: string | null;
  /** History freshness (from freshness()) — null when the channel has no archive yet. */
  fresh: Freshness | null;
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

export function overviewHealthBanner({ source, connectionState, fresh }: HealthInput): HealthBanner | null {
  const stale = fresh?.stale ?? false;
  const lastLabel = fresh?.label ?? null;

  if (source === 'qr') {
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
    // Live (or unknown) session but the archive has aged — an honest freshness nudge, never a claim
    // that the session is revoked.
    if (stale) {
      return {
        tone: 'warn',
        message: `Данные устарели — последний сбор ${lastLabel}. Проверьте подключение Telegram.`,
        cta: QR_REFRESH_LINK,
      };
    }
    return null;
  }

  // Non-QR sources have no managed session to repair — only stale history warrants a banner.
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
export function sidebarHealth({ source, connectionState, fresh }: HealthInput): SidebarHealth | null {
  if (source === 'qr' && connectionState === 'reauth_required') {
    return { tone: 'error', label: 'нужно переподключить' };
  }
  if (source === 'qr' && connectionState === 'degraded') {
    return { tone: 'warn', label: 'сбор временно недоступен' };
  }
  if (!fresh) return null;
  return {
    tone: fresh.stale ? 'warn' : 'ok',
    label: `обновлено ${fresh.label}`,
  };
}
