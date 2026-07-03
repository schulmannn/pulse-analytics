import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlan, isPaidPlan, setPlan } from './plan';

// The suite runs in a node environment — give the store a minimal in-memory localStorage.
beforeAll(() => {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
  };
});

describe('plan store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to free', () => {
    expect(getPlan()).toBe('free');
  });

  it('persists pro/max and round-trips', () => {
    setPlan('pro');
    expect(getPlan()).toBe('pro');
    setPlan('max');
    expect(getPlan()).toBe('max');
  });

  it('free clears the stored flag', () => {
    setPlan('max');
    setPlan('free');
    expect(localStorage.getItem('pulse_plan')).toBeNull();
    expect(getPlan()).toBe('free');
  });

  it('ignores garbage in storage', () => {
    localStorage.setItem('pulse_plan', 'enterprise');
    expect(getPlan()).toBe('free');
  });

  it('isPaidPlan gates on paid tiers', () => {
    expect(isPaidPlan('free')).toBe(false);
    expect(isPaidPlan('pro')).toBe(true);
    expect(isPaidPlan('max')).toBe(true);
  });
});
