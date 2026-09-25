import { describe, expect, it } from 'vitest';
import type { Channel } from '@/api/schemas';
import { channelsForSource, isEligibleSource, resolveHomeSourceChannel } from './channelSource';

// Minimal channel fixtures covering the shapes the switcher distinguishes:
//  - a plain Telegram channel (no source, not IG-connected)
//  - a Telegram channel with a linked Instagram account (ig_connected)
//  - a standalone Instagram source (source === 'ig')
//  - a standalone MoySklad source (source === 'ms') — не принадлежит ни TG, ни IG
//  - a standalone Yandex Metrika source (source === 'ym') — тоже не принадлежит ни TG, ни IG
const tg: Channel = { id: 1, username: 'bynotem', title: 'bynotem', source: null, ig_connected: false };
const tgWithIg: Channel = { id: 2, username: 'tydaaya', title: 'tydaaya', source: null, ig_connected: true };
const igStandalone: Channel = { id: 3, username: 'ig_only', title: 'ig_only', source: 'ig', ig_connected: false };
const msStandalone: Channel = { id: 4, username: null, title: 'ИП Хайдукова', source: 'ms', ig_connected: false };
const ymStandalone: Channel = { id: 5, username: null, title: 'notem.ru', source: 'ym', ig_connected: false };
const all = [tg, tgWithIg, igStandalone, msStandalone, ymStandalone];

describe('channelsForSource', () => {
  it('Telegram list excludes standalone Instagram sources', () => {
    expect(channelsForSource(all, 'tg').map((c) => c.id)).toEqual([1, 2]);
  });

  it('Telegram list excludes standalone MoySklad sources (склад — не Telegram)', () => {
    expect(channelsForSource([msStandalone, tg], 'tg').map((c) => c.id)).toEqual([1]);
    expect(isEligibleSource(all, 'tg', 4)).toBe(false);
  });

  it('Telegram list excludes standalone Metrika sources (счётчик — не Telegram)', () => {
    expect(channelsForSource([ymStandalone, tg], 'tg').map((c) => c.id)).toEqual([1]);
    expect(isEligibleSource(all, 'tg', 5)).toBe(false);
  });

  it('Metrika list offers only standalone ym channels', () => {
    expect(channelsForSource(all, 'ym').map((c) => c.id)).toEqual([5]);
    expect(channelsForSource([tg, msStandalone], 'ym')).toEqual([]);
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

describe('resolveHomeSourceChannel (авто-пин виджета Главной без явного источника)', () => {
  it('запомненный канал сети берётся, когда он существует и подходит сети', () => {
    expect(resolveHomeSourceChannel(all, 'tg', 2)).toBe(2);
    expect(resolveHomeSourceChannel(all, 'ig', 2)).toBe(2);
  });

  it('запомненный канал ДРУГОЙ сети (МойСклад/IG на TG-виджете) игнорируется → первый подходящий', () => {
    expect(resolveHomeSourceChannel(all, 'tg', 4)).toBe(1); // remembered = склад
    expect(resolveHomeSourceChannel(all, 'tg', 3)).toBe(1); // remembered = standalone IG
    expect(resolveHomeSourceChannel(all, 'ig', 1)).toBe(2); // remembered = TG без IG
  });

  it('без запомненного — первый подходящий канал сети; без каналов сети — null', () => {
    expect(resolveHomeSourceChannel(all, 'tg', null)).toBe(1);
    expect(resolveHomeSourceChannel([msStandalone], 'tg', null)).toBeNull();
    expect(resolveHomeSourceChannel([tg, msStandalone], 'ig', null)).toBeNull();
  });

  it('ym-виджет пинится к каналу Метрики; чужой запомненный канал игнорируется', () => {
    expect(resolveHomeSourceChannel(all, 'ym', null)).toBe(5);
    expect(resolveHomeSourceChannel(all, 'ym', 1)).toBe(5); // remembered = TG
    expect(resolveHomeSourceChannel([tg, msStandalone], 'ym', null)).toBeNull();
  });
});
