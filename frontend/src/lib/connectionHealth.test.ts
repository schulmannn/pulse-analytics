import { describe, expect, it } from 'vitest';
import { orbitHealth, overviewHealthBanner } from './connectionHealth';
import type { Freshness } from './freshness';

const fresh: Freshness = { label: 'сегодня', stale: false };
const stale: Freshness = { label: '4 дн. назад', stale: true };

const RECONNECT_TO = '/connect?source=telegram&tab=qr&action=reconnect';
const QR_STATUS_TO = '/connect?source=telegram&tab=qr';
const QR_REFRESH_TO = '/connect?source=telegram&tab=qr&action=reconnect';
const AGENT_TO = '/connect?source=telegram&tab=agent';

describe('overviewHealthBanner — source=qr', () => {
  it('reauth_required → error tone + exact reconnect CTA, even when history is still fresh', () => {
    const banner = overviewHealthBanner({ source: 'qr', connectionState: 'reauth_required', fresh });
    expect(banner?.tone).toBe('error');
    expect(banner?.cta).toEqual({ label: 'Переподключить Telegram →', to: RECONNECT_TO });
    expect(banner?.message).toContain('недействительна');
    expect(banner?.message).toContain('не поступают');
  });

  it('reauth_required wins over stale history (still the error/reconnect banner)', () => {
    const banner = overviewHealthBanner({ source: 'qr', connectionState: 'reauth_required', fresh: stale });
    expect(banner?.tone).toBe('error');
    expect(banner?.cta?.to).toBe(RECONNECT_TO);
  });

  it('degraded → warn tone, no reconnect language, non-reconnect CTA', () => {
    const banner = overviewHealthBanner({ source: 'qr', connectionState: 'degraded', fresh });
    expect(banner?.tone).toBe('warn');
    expect(banner?.message).not.toMatch(/недействительн|переподключит/i);
    expect(banner?.message).toContain('автоматически');
    // Never the reconnect deep link.
    expect(banner?.cta?.to).toBe(QR_STATUS_TO);
    expect(banner?.cta?.to).not.toContain('action=reconnect');
  });

  it('degraded shows even when history is fresh (transient outage is current)', () => {
    expect(overviewHealthBanner({ source: 'qr', connectionState: 'degraded', fresh })).not.toBeNull();
  });

  it('live/unknown session + stale history → honest freshness nudge, not a revocation claim', () => {
    const banner = overviewHealthBanner({ source: 'qr', connectionState: 'connected', fresh: stale });
    expect(banner?.tone).toBe('warn');
    expect(banner?.message).toContain('4 дн. назад');
    expect(banner?.message).not.toMatch(/недействительн/i);
    expect(banner?.cta).toEqual({ label: 'Обновить подключение →', to: QR_REFRESH_TO });
  });

  it('null connection_state + stale (status not yet loaded) → honest stale nudge', () => {
    const banner = overviewHealthBanner({ source: 'qr', connectionState: null, fresh: stale });
    expect(banner?.tone).toBe('warn');
    expect(banner?.cta?.to).toBe(QR_REFRESH_TO);
  });

  it('connected + fresh → no banner', () => {
    expect(overviewHealthBanner({ source: 'qr', connectionState: 'connected', fresh })).toBeNull();
    expect(overviewHealthBanner({ source: 'qr', connectionState: null, fresh })).toBeNull();
    expect(overviewHealthBanner({ source: 'qr', connectionState: null, fresh: null })).toBeNull();
  });
});

describe('overviewHealthBanner — source=collector', () => {
  it('stale → collector-appropriate CTA to the agent tab, no QR mention', () => {
    const banner = overviewHealthBanner({ source: 'collector', connectionState: null, fresh: stale });
    expect(banner?.tone).toBe('warn');
    expect(banner?.message).toContain('collector-агент');
    expect(banner?.message).not.toMatch(/QR/i);
    expect(banner?.cta).toEqual({ label: 'Проверить агента →', to: AGENT_TO });
  });

  it('fresh → no banner', () => {
    expect(overviewHealthBanner({ source: 'collector', connectionState: null, fresh })).toBeNull();
    expect(overviewHealthBanner({ source: 'collector', connectionState: null, fresh: null })).toBeNull();
  });
});

describe('overviewHealthBanner — source=central, NON-owner (or ownership unknown)', () => {
  it('stale → generic notice only, no CTA and no QR-repair claim', () => {
    const banner = overviewHealthBanner({ source: 'central', connectionState: null, fresh: stale });
    expect(banner?.tone).toBe('warn');
    expect(banner?.cta).toBeNull();
    expect(banner?.message).not.toMatch(/QR|переподключ|агент/i);
  });

  it('non-owner ignores connection_state (no repair CTA even on reauth_required)', () => {
    // A non-owner cannot repair the central session; a stray reauth state must not surface a CTA.
    const banner = overviewHealthBanner({ source: 'central', connectionState: 'reauth_required', fresh, centralOwner: false });
    expect(banner).toBeNull();
    const staleBanner = overviewHealthBanner({ source: 'central', connectionState: 'reauth_required', fresh: stale, centralOwner: false });
    expect(staleBanner?.cta).toBeNull();
  });

  it('unknown source behaves like central (generic stale, no CTA)', () => {
    const banner = overviewHealthBanner({ source: undefined, connectionState: null, fresh: stale });
    expect(banner?.cta).toBeNull();
    expect(banner?.tone).toBe('warn');
  });

  it('fresh → no banner', () => {
    expect(overviewHealthBanner({ source: 'central', connectionState: null, fresh })).toBeNull();
  });
});

describe('overviewHealthBanner — source=central, OWNER (managed session is the collector)', () => {
  it('reauth_required → error tone + exact reconnect CTA, even when history is still fresh', () => {
    const banner = overviewHealthBanner({ source: 'central', connectionState: 'reauth_required', fresh, centralOwner: true });
    expect(banner?.tone).toBe('error');
    expect(banner?.cta).toEqual({ label: 'Переподключить Telegram →', to: RECONNECT_TO });
    expect(banner?.message).toContain('недействительна');
  });

  it('degraded → warn, no reconnect demand (status link only)', () => {
    const banner = overviewHealthBanner({ source: 'central', connectionState: 'degraded', fresh, centralOwner: true });
    expect(banner?.tone).toBe('warn');
    expect(banner?.message).not.toMatch(/недействительн|переподключит/i);
    expect(banner?.cta?.to).toBe(QR_STATUS_TO);
    expect(banner?.cta?.to).not.toContain('action=reconnect');
  });

  it('stale live/unknown session → honest stale nudge + update link, without claiming revocation', () => {
    const banner = overviewHealthBanner({ source: 'central', connectionState: 'connected', fresh: stale, centralOwner: true });
    expect(banner?.tone).toBe('warn');
    expect(banner?.message).toContain('4 дн. назад');
    expect(banner?.message).not.toMatch(/недействительн/i);
    expect(banner?.cta).toEqual({ label: 'Обновить подключение →', to: QR_REFRESH_TO });
  });

  it('connected + fresh → no banner', () => {
    expect(overviewHealthBanner({ source: 'central', connectionState: 'connected', fresh, centralOwner: true })).toBeNull();
  });
});

describe('orbitHealth', () => {
  const now = Date.UTC(2026, 7, 13, 12);

  it('maps only the canonical managed Telegram failure states', () => {
    expect(
      orbitHealth({ telegram: { managed: true, connectionState: 'reauth_required' }, now })
        .telegram,
    ).toEqual({ health: 'error', reason: 'сессия недействительна' });
    expect(
      orbitHealth({ telegram: { managed: true, connectionState: 'degraded' }, now }).telegram,
    ).toEqual({ health: 'warn', reason: 'временно недоступен' });
    expect(
      orbitHealth({ telegram: { managed: true, connectionState: 'connected' }, now }).telegram,
    ).toEqual({ health: 'ok', reason: null });
    expect(
      orbitHealth({ telegram: { managed: true, connectionState: 'future_state' }, now }).telegram,
    ).toEqual({ health: 'ok', reason: null });
  });

  it('ignores managed-session state for collector-only / central non-owner Telegram', () => {
    expect(
      orbitHealth({ telegram: { managed: false, connectionState: 'reauth_required' }, now })
        .telegram,
    ).toEqual({ health: 'ok', reason: null });
  });

  it('maps an expired Instagram token to error', () => {
    expect(
      orbitHealth({
        instagram: {
          connected: true,
          tokenExpiresAt: new Date(now - 1).toISOString(),
        },
        now,
      }).instagram,
    ).toEqual({ health: 'error', reason: 'токен истёк' });
  });

  it('maps an Instagram token expiring within seven days to warn with remaining days', () => {
    expect(
      orbitHealth({
        instagram: {
          connected: true,
          tokenExpiresAt: new Date(now + 6.25 * 24 * 60 * 60 * 1000).toISOString(),
        },
        now,
      }).instagram,
    ).toEqual({ health: 'warn', reason: 'токен истекает 7 дн' });
  });

  it('keeps long-lived, invalid-date and environment-fallback Instagram statuses ok', () => {
    expect(
      orbitHealth({
        instagram: {
          connected: true,
          tokenExpiresAt: new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString(),
        },
        now,
      }).instagram.health,
    ).toBe('ok');
    expect(
      orbitHealth({ instagram: { connected: true, tokenExpiresAt: 'not-a-date' }, now }).instagram
        .health,
    ).toBe('ok');
    expect(
      orbitHealth({
        instagram: {
          connected: false,
          envFallback: true,
          tokenExpiresAt: new Date(now - 1).toISOString(),
        },
        now,
      }).instagram.health,
    ).toBe('ok');
  });

  it('does not invent health signals for current MS/YM status shapes', () => {
    const health = orbitHealth({
      moysklad: { connected: true },
      metrika: { connected: true },
      now,
    });
    expect(health.moysklad).toEqual({ health: 'ok', reason: null });
    expect(health.metrika).toEqual({ health: 'ok', reason: null });
  });
});
