import { describe, expect, it } from 'vitest';
import { overviewHealthBanner, sidebarHealth } from './connectionHealth';
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

describe('overviewHealthBanner — source=central / other', () => {
  it('stale → generic notice only, no CTA and no QR-repair claim', () => {
    const banner = overviewHealthBanner({ source: 'central', connectionState: null, fresh: stale });
    expect(banner?.tone).toBe('warn');
    expect(banner?.cta).toBeNull();
    expect(banner?.message).not.toMatch(/QR|переподключ|агент/i);
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

describe('sidebarHealth', () => {
  it('prioritises actionable QR auth state over freshness', () => {
    expect(sidebarHealth({ source: 'qr', connectionState: 'reauth_required', fresh })).toEqual({
      tone: 'error',
      label: 'нужно переподключить',
    });
  });

  it('keeps transient QR degradation distinct from reauth', () => {
    expect(sidebarHealth({ source: 'qr', connectionState: 'degraded', fresh })).toEqual({
      tone: 'warn',
      label: 'сбор временно недоступен',
    });
  });

  it('falls back to the familiar freshness label', () => {
    expect(sidebarHealth({ source: 'qr', connectionState: 'connected', fresh })).toEqual({
      tone: 'ok',
      label: 'обновлено сегодня',
    });
    expect(sidebarHealth({ source: 'collector', connectionState: null, fresh: stale })).toEqual({
      tone: 'warn',
      label: 'обновлено 4 дн. назад',
    });
  });

  it('reserves the loading state when neither health nor freshness is known', () => {
    expect(sidebarHealth({ source: 'qr', connectionState: null, fresh: null })).toBeNull();
  });
});
