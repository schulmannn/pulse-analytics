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
import { legacyKeyForMetricId } from '@/lib/legacyWidgets';

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

// Account-sync seam: the prefs-sync layer (ChartWidget) registers a hook here so a LOCAL mutation
// mirrors into the account blob (GET/PUT /api/prefs). Kept as a hook rather than an import so this
// store never depends on the component layer (no import cycle). Hydrating FROM the account uses
// hydrateWidgetConfigs below, which deliberately does NOT fire this hook — otherwise seeding the
// server's copy would immediately schedule a push of it straight back.
let onMutate: (() => void) | null = null;
export function setWidgetConfigsSyncHook(fn: (() => void) | null) {
  onMutate = fn;
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
  onMutate?.();
}

/** Seed the store from the account blob (cross-device hydrate) WITHOUT scheduling an account push —
 *  the data already came from the server. Validated like every other write, so a corrupt/foreign
 *  blob can never crash a surface. */
export function hydrateWidgetConfigs(raw: unknown) {
  const next = normalizeWidgets(raw);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked — server copy just isn't cached locally */
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

// ── Account-sync reconciliation (used by the prefs-sync layer) ───────────────────────────────────
// Legacy composites (metricId `legacy:<key>`) are re-derived per device from the account-synced Home
// pins + prefs, so they must stay OUT of the account blob — syncing them would resurrect a card
// another device intentionally cleared.
const isLegacyConfig = (c: WidgetConfig): boolean => legacyKeyForMetricId(c.metricId) != null;

/** The builder configs this device should MIRROR to the account — legacy composites excluded. */
export function syncableWidgetConfigs(): WidgetConfig[] {
  return getWidgetConfigs().filter((c) => !isLegacyConfig(c));
}

/**
 * Reconcile the account's builder configs with this device's local set at hydrate time.
 *  - Device-local legacy configs are always PRESERVED (they never came from / go to the account).
 *  - The account's real configs WIN (cross-device intent) — EXCEPT a config that was CREATED IN THIS
 *    SESSION while the account GET was in flight (its id is absent from `baselineIds`, the snapshot of
 *    syncable ids taken at mount) and isn't in the account yet: it's UNIONED in so a widget built in
 *    that window is never silently deleted by account-wins.
 * The baseline snapshot is what makes this precise: a PRE-EXISTING stale local widget (present at
 * mount, deleted on another device) is in `baselineIds`, so it is NOT unioned — account-wins drops it
 * correctly, and only genuinely-new-in-window widgets survive.
 * Returns the set to seed locally + whether the merge added something the account must be told about.
 */
export function reconcileHydratedConfigs(
  accountRaw: unknown,
  baselineIds: ReadonlySet<string>,
): { seed: WidgetConfig[]; pushBack: boolean } {
  const account = normalizeWidgets(accountRaw).filter((c) => !isLegacyConfig(c));
  const local = getWidgetConfigs();
  const localLegacy = local.filter(isLegacyConfig);
  const accountIds = new Set(account.map((c) => c.id));
  const racedExtras = local.filter(
    (c) => !isLegacyConfig(c) && !accountIds.has(c.id) && !baselineIds.has(c.id),
  );
  return { seed: [...account, ...racedExtras, ...localLegacy], pushBack: racedExtras.length > 0 };
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
