import { describe, expect, it } from 'vitest';
import { networkDisplayName } from './networks';

describe('networkDisplayName — WidgetRenderer meta network label', () => {
  it('maps ms to МойСклад (not Telegram)', () => {
    expect(networkDisplayName('ms')).toBe('МойСклад');
  });

  it('keeps the existing tg / ig labels', () => {
    expect(networkDisplayName('tg')).toBe('Telegram');
    expect(networkDisplayName('ig')).toBe('Instagram');
  });

  it('falls back to the default network for an unknown key', () => {
    expect(networkDisplayName('vk')).toBe('Telegram');
  });
});
