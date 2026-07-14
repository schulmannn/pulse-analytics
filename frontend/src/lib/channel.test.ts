import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getRememberedChannel,
  getSelectedChannel,
  setRememberedChannel,
  setSelectedChannel,
} from '@/lib/channel';

// vitest runs in node — provide an in-memory localStorage so the store's persistence works.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

beforeAll(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
});

beforeEach(() => {
  localStorage.clear();
  // Reset the module-level per-network memory (a singleton shared across cases in this file).
  setRememberedChannel('tg', null);
  setRememberedChannel('ig', null);
  setSelectedChannel(null);
});

describe('active channel (pulse_channel, network-agnostic)', () => {
  it('round-trips and clears the legacy single value the API client reads', () => {
    setSelectedChannel(7);
    expect(getSelectedChannel()).toBe(7);
    expect(localStorage.getItem('pulse_channel')).toBe('7');

    setSelectedChannel(null);
    expect(getSelectedChannel()).toBeNull();
    expect(localStorage.getItem('pulse_channel')).toBeNull();
  });
});

describe('per-network source memory', () => {
  it('remembers each network independently (a source is (network, channel))', () => {
    setRememberedChannel('tg', 2);
    setRememberedChannel('ig', 9);
    expect(getRememberedChannel('tg')).toBe(2);
    expect(getRememberedChannel('ig')).toBe(9);
  });

  it('persists as a single JSON map', () => {
    setRememberedChannel('tg', 2);
    setRememberedChannel('ig', 9);
    expect(JSON.parse(localStorage.getItem('pulse_source_channels') ?? '{}')).toEqual({ tg: 2, ig: 9 });
  });

  it('falls back to the legacy pulse_channel value when a network has no entry (migration)', () => {
    setSelectedChannel(42); // legacy single value, no per-network map yet
    expect(getRememberedChannel('tg')).toBe(42);
    expect(getRememberedChannel('ig')).toBe(42);

    // Once a network is remembered, its own value wins over the legacy fallback.
    setRememberedChannel('ig', 5);
    expect(getRememberedChannel('ig')).toBe(5);
    expect(getRememberedChannel('tg')).toBe(42);
  });

  it('clearing a network entry restores the legacy fallback', () => {
    setSelectedChannel(42);
    setRememberedChannel('tg', 7);
    expect(getRememberedChannel('tg')).toBe(7);

    setRememberedChannel('tg', null);
    expect(getRememberedChannel('tg')).toBe(42);
  });

  it('returns null when neither the network nor the legacy value is set', () => {
    expect(getRememberedChannel('tg')).toBeNull();
    expect(getRememberedChannel('ig')).toBeNull();
  });
});
