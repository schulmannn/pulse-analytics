import { describe, expect, it } from 'vitest';
import { defaultHomeKeys, HOME_LEGACY_DEFAULT_KEYS } from './homeDefaults';
import { HOME_REGISTRY } from './homeWidgets';

describe('defaultHomeKeys', () => {
  it('seeds a Telegram-first default without IG when no channel exposes Instagram', () => {
    const keys = defaultHomeKeys([{ source: 'collector', ig_connected: false }]);
    expect(keys).toEqual(['kpi', 'week', 'growth', 'top-posts']);
    expect(keys.some((k) => k.startsWith('ig-'))).toBe(false);
  });

  it('inserts the IG reach card when a connected Instagram source exists', () => {
    const keys = defaultHomeKeys([{ source: 'collector', ig_connected: true }]);
    // KPI band → explanation + trends → IG reach → editorial content.
    expect(keys).toEqual(['kpi', 'week', 'growth', 'ig-reach', 'top-posts']);
  });

  it('seeds an all-Instagram default for an IG-only workspace (no Telegram side)', () => {
    const keys = defaultHomeKeys([{ source: 'ig', ig_connected: true }]);
    expect(keys).toEqual(['ig-kpi', 'ig-week', 'ig-reach']);
    expect(keys.every((k) => k.startsWith('ig-'))).toBe(true);
  });

  // В HOME_REGISTRY нет кураторских карточек склада и Метрики, поэтому telegram-first сев на таком
  // workspace давал четыре виджета, которым неоткуда взять источник.
  it('seeds an empty board for a МойСклад-only workspace instead of dead Telegram widgets', () => {
    expect(defaultHomeKeys([{ source: 'ms' }])).toEqual([]);
  });

  it('seeds an empty board for a Яндекс.Метрика-only workspace instead of dead Telegram widgets', () => {
    expect(defaultHomeKeys([{ source: 'ym' }])).toEqual([]);
  });

  it('still seeds the Telegram default when a ym/ms source sits NEXT TO a Telegram channel', () => {
    expect(defaultHomeKeys([{ source: 'ym' }, { source: 'collector' }])).toEqual([
      'kpi', 'week', 'growth', 'top-posts',
    ]);
  });

  it('treats a mixed workspace (a TG channel + a linked IG account) as TG-first with IG reach', () => {
    const keys = defaultHomeKeys([
      { source: 'collector', ig_connected: false },
      { source: 'collector', ig_connected: true },
    ]);
    expect(keys).toEqual(['kpi', 'week', 'growth', 'ig-reach', 'top-posts']);
  });

  it('falls back to the Telegram-first default when no channels have loaded yet', () => {
    expect(defaultHomeKeys()).toEqual(['kpi', 'week', 'growth', 'top-posts']);
    expect(defaultHomeKeys([])).toEqual(['kpi', 'week', 'growth', 'top-posts']);
  });

  it('only ever emits keys that exist in the Home registry', () => {
    const cases = [
      defaultHomeKeys([{ source: 'collector' }]),
      defaultHomeKeys([{ source: 'collector', ig_connected: true }]),
      defaultHomeKeys([{ source: 'ig', ig_connected: true }]),
    ];
    for (const keys of cases) {
      for (const key of keys) expect(HOME_REGISTRY[key], `${key} in registry`).toBeTruthy();
    }
  });

  it('keeps the deferred mobile seed byte-for-byte compatible with the old surface', () => {
    expect([...HOME_LEGACY_DEFAULT_KEYS]).toEqual(['week', 'kpi', 'growth', 'ig-reach', 'top-posts']);
  });
});
