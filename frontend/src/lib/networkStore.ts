import { useEffect, useSyncExternalStore } from 'react';
import { NETWORKS, routeNetworkOwner, type Network } from '@/lib/networks';

/**
 * ACTIVE-NETWORK SELECTION STORE — the persisted "which network am I looking at" that survives
 * network-agnostic routes. The old model derived the active network purely from the URL
 * (networkForPath), so any shared surface (/home, /reports, /campaigns/:id, /settings) snapped the
 * whole shell — sidebar nav, source switcher badge, mobile segment — back to Telegram. This store
 * keeps the last EXPLICIT choice instead: a route that owns a network (routeNetworkOwner) wins
 * immediately and updates persistence; an agnostic route retains the stored value.
 *
 * localStorage-backed (same key style as pulse_channel / pulse_theme), reactive via
 * useSyncExternalStore, and SSR/test-safe (every storage access is guarded; the default network is
 * the registry's first entry).
 */

const STORAGE_KEY = 'pulse_network';
const DEFAULT_NETWORK: Network = NETWORKS[0].key;

function isNetwork(value: string | null): value is Network {
  return value != null && NETWORKS.some((n) => n.key === value);
}

function readStored(): Network {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isNetwork(raw) ? raw : DEFAULT_NETWORK;
  } catch {
    return DEFAULT_NETWORK;
  }
}

/** Route ownership must win before React mounts: ChannelProvider reads this store while it is still
    above BrowserRouter, and uses the result to choose the first X-Channel-Id. Deferring the owner to
    useNetworkSelection's effect can otherwise bootstrap a TG route with the remembered IG channel. */
function readInitial(): Network {
  try {
    return routeNetworkOwner(window.location.pathname) ?? readStored();
  } catch {
    return readStored();
  }
}

let current: Network = readInitial();
const listeners = new Set<() => void>();

/** The persisted active network (last explicit choice). Non-reactive read, for event handlers. */
export function getActiveNetwork(): Network {
  return current;
}

/** Set + persist the active network, notifying subscribers. No-op when unchanged. */
export function setActiveNetwork(next: Network): void {
  if (current === next) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable — selection just won't survive a reload */
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => current;

/**
 * The active network for a pathname. A route that OWNS a network selects it immediately (returned
 * this render, so the shell never flickers) and persists it via an effect; a network-agnostic route
 * falls through to the persisted/current value. Reactive across the whole app.
 */
export function useNetworkSelection(pathname: string): Network {
  const stored = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const owner = routeNetworkOwner(pathname);
  useEffect(() => {
    if (owner) setActiveNetwork(owner);
  }, [owner]);
  return owner ?? stored;
}
