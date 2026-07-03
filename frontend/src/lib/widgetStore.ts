// Persistence for user-built widgets (WidgetConfig[]) — the store behind the metric builder. Same
// localStorage-first + pub-sub pattern as the widget-prefs store in ChartWidget, kept standalone so
// the config model stays decoupled from the card component and the pure store logic is testable with
// a localStorage stub (vitest runs in node).
//
// Reads always go through normalizeWidgets, so a corrupt / stale / foreign blob can never crash a
// surface — worst case an unusable entry is dropped. Account sync (mirroring into /api/prefs) is a
// deliberate follow-up: this ships as device-local first (zero risk to the existing prefs sync), and
// the blob adopts the same GET/PUT plumbing once the mount is proven.

import { useSyncExternalStore } from 'react';
import {
  defaultWidget,
  normalizeWidget,
  normalizeWidgets,
  type WidgetConfig,
} from '@/lib/widgetConfig';

const KEY = 'pulse_widget_configs';

// ── pub-sub ───────────────────────────────────────────────────────────────────────────────────
const listeners = new Set<() => void>();
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function notify() {
  listeners.forEach((l) => l());
}

// Stable snapshot cache — useSyncExternalStore MUST get the same reference when nothing changed, or
// it re-renders forever. Recompute only when the stored raw string actually differs.
let cacheRaw: string | null | undefined;
let cacheVal: WidgetConfig[] = [];
function snapshot(): WidgetConfig[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw === cacheRaw) return cacheVal;
  cacheRaw = raw;
  try {
    cacheVal = normalizeWidgets(JSON.parse(raw ?? 'null'));
  } catch {
    cacheVal = [];
  }
  return cacheVal;
}

function write(configs: WidgetConfig[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(configs));
  } catch {
    /* storage blocked — the builder is a nicety */
  }
  notify();
}

/** The current widget configs (validated, stable reference until the next mutation). */
export function getWidgetConfigs(): WidgetConfig[] {
  return snapshot();
}

/** Replace the whole list (validated). */
export function setWidgetConfigs(configs: WidgetConfig[] | unknown) {
  write(normalizeWidgets(configs));
}

export function getWidgetConfig(id: string): WidgetConfig | undefined {
  return getWidgetConfigs().find((c) => c.id === id);
}

/** Append a validated config (dedup guaranteed by normalizeWidgets). Returns the stored config, or
 *  null if the raw config isn't valid (unknown metric). */
export function addWidgetConfig(raw: unknown): WidgetConfig | null {
  const w = normalizeWidget(raw);
  if (!w) return null;
  const next = normalizeWidgets([...getWidgetConfigs(), w]);
  write(next);
  // The stored copy may have had its id reassigned on collision — return the last entry.
  return next[next.length - 1] ?? null;
}

/** Append a fresh default widget for a metric (its default viz, no options). Null for unknown id. */
export function addWidgetForMetric(metricId: string): WidgetConfig | null {
  const w = defaultWidget(metricId);
  return w ? addWidgetConfig(w) : null;
}

/** Patch a widget by id (validated after merge). No-op if the id is unknown. */
export function updateWidgetConfig(id: string, patch: Partial<WidgetConfig>) {
  const next = getWidgetConfigs().map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c));
  write(normalizeWidgets(next));
}

/** Remove a widget by id. */
export function removeWidgetConfig(id: string) {
  write(getWidgetConfigs().filter((c) => c.id !== id));
}

/** Reactive list of configs for React surfaces (Home / builder). */
export function useWidgetConfigs(): WidgetConfig[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test seam: drop the in-memory snapshot cache so a fresh localStorage stub is re-read. */
export function __resetWidgetStoreCache() {
  cacheRaw = undefined;
  cacheVal = [];
}
