import { describe, expect, it } from 'vitest';
import type { Channel } from '@/api/schemas';
import { channelsForSource, isEligibleSource } from './channelSource';

// Minimal channel fixtures covering the three shapes the switcher distinguishes:
//  - a plain Telegram channel (no source, not IG-connected)
//  - a Telegram channel with a linked Instagram account (ig_connected)
//  - a standalone Instagram source (source === 'ig')
const tg: Channel = { id: 1, username: 'bynotem', title: 'bynotem', source: null, ig_connected: false };
const tgWithIg: Channel = { id: 2, username: 'tydaaya', title: 'tydaaya', source: null, ig_connected: true };
const igStandalone: Channel = { id: 3, username: 'ig_only', title: 'ig_only', source: 'ig', ig_connected: false };
const all = [tg, tgWithIg, igStandalone];

describe('channelsForSource', () => {
  it('Telegram list excludes standalone Instagram sources', () => {
    expect(channelsForSource(all, 'tg').map((c) => c.id)).toEqual([1, 2]);
  });

  it('Instagram list offers only channels with a linked IG account', () => {
    expect(channelsForSource(all, 'ig').map((c) => c.id)).toEqual([2]);
  });

  it('never lets a Telegram-only channel appear under an Instagram metric', () => {
    expect(channelsForSource([tg], 'ig')).toEqual([]);
  });

  it('returns empty for Instagram when nothing is connected (drives the empty-state hint)', () => {
    expect(channelsForSource([tg, igStandalone], 'ig')).toEqual([]);
  });

  it('is stable when the list is empty', () => {
    expect(channelsForSource([], 'tg')).toEqual([]);
    expect(channelsForSource([], 'ig')).toEqual([]);
  });
});

describe('isEligibleSource', () => {
  it('accepts a valid same-network pin', () => {
    expect(isEligibleSource(all, 'tg', 1)).toBe(true);
    expect(isEligibleSource(all, 'ig', 2)).toBe(true);
  });

  it('rejects a cross-network pin (a Telegram channel left on an Instagram widget)', () => {
    expect(isEligibleSource(all, 'ig', 1)).toBe(false);
    expect(isEligibleSource(all, 'tg', 3)).toBe(false);
  });

  it('rejects an id that is not in the list', () => {
    expect(isEligibleSource(all, 'tg', 999)).toBe(false);
  });
});
