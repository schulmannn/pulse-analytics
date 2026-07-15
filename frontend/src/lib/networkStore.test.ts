import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routeNetworkOwner } from '@/lib/networks';
import { getActiveNetwork, setActiveNetwork } from '@/lib/networkStore';

// vitest runs in node — provide an in-memory localStorage so the store's persistence works.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
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
  // Reset the singleton to the default network between cases (the store is module-level state).
  setActiveNetwork('ig');
  setActiveNetwork('tg');
});

describe('routeNetworkOwner — exact route ownership', () => {
  it('claims the whole Instagram family for ig', () => {
    expect(routeNetworkOwner('/instagram')).toBe('ig');
    expect(routeNetworkOwner('/instagram/analytics')).toBe('ig');
    expect(routeNetworkOwner('/instagram/content')).toBe('ig');
    expect(routeNetworkOwner('/instagram/audience')).toBe('ig');
  });

  it('claims exactly the TG feed routes for tg', () => {
    expect(routeNetworkOwner('/')).toBe('tg');
    expect(routeNetworkOwner('/analytics')).toBe('tg');
    expect(routeNetworkOwner('/posts')).toBe('tg');
    expect(routeNetworkOwner('/mentions')).toBe('tg');
  });

  it('splits /metrics by the ig- prefix', () => {
    expect(routeNetworkOwner('/metrics/ig-reach')).toBe('ig');
    expect(routeNetworkOwner('/metrics/ig-follows')).toBe('ig');
    expect(routeNetworkOwner('/metrics/views')).toBe('tg');
    expect(routeNetworkOwner('/metrics/er')).toBe('tg');
  });

  it('reports null for network-agnostic surfaces (the store decides there)', () => {
    for (const path of ['/home', '/reports', '/reports/5', '/campaigns/12', '/settings', '/admin', '/bugs', '/connect']) {
      expect(routeNetworkOwner(path)).toBeNull();
    }
  });

  it('does not let a TG feed route match by prefix', () => {
    // Only EXACT feed paths are owned — a deeper path is agnostic, not TG-by-prefix.
    expect(routeNetworkOwner('/posts/123')).toBeNull();
    expect(routeNetworkOwner('/analytics/extra')).toBeNull();
  });
});

describe('network selection store — persistence & reactivity', () => {
  it('reflects the last explicit choice and persists it', () => {
    setActiveNetwork('ig');
    expect(getActiveNetwork()).toBe('ig');
    expect(localStorage.getItem('pulse_network')).toBe('ig');

    setActiveNetwork('tg');
    expect(getActiveNetwork()).toBe('tg');
    expect(localStorage.getItem('pulse_network')).toBe('tg');
  });

  it('retains the persisted network across an agnostic read (owner ?? stored)', () => {
    setActiveNetwork('ig');
    // On an agnostic route routeNetworkOwner is null, so the active network is the stored one.
    const active = routeNetworkOwner('/home') ?? getActiveNetwork();
    expect(active).toBe('ig');
  });

  it('an owned route wins over the stored network', () => {
    setActiveNetwork('ig');
    const active = routeNetworkOwner('/posts') ?? getActiveNetwork();
    expect(active).toBe('tg');
  });

  // Regression: directly loading an owned route (e.g. /instagram) bootstraps `current` from the
  // route while localStorage may still hold a stale value ('tg'). The owned route's effect then
  // calls setActiveNetwork with the SAME network — which used to early-return and leave the stale
  // value in storage, so a later direct load of /home or /reports snapped back to the old network.
  it('repairs stale storage even when the active network is unchanged', () => {
    setActiveNetwork('ig');
    expect(localStorage.getItem('pulse_network')).toBe('ig');

    // Simulate the boot state: `current` is already 'ig' (route owner) but storage was never healed.
    localStorage.setItem('pulse_network', 'tg');

    // The no-op effect call must still write the current network back through to storage.
    setActiveNetwork('ig');
    expect(getActiveNetwork()).toBe('ig');
    expect(localStorage.getItem('pulse_network')).toBe('ig');
  });
});
