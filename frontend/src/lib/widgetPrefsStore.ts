import { createContext, useEffect, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { apiGet, apiSend } from '@/api/client';
import { isDemoMode } from '@/lib/demo';
import { parsePrefs } from '@/lib/prefsSchema';
import { preserveEntryIdentity, preserveValueIdentity } from '@/lib/storeIdentity';
import { hydrateWidgetConfigs, reconcileHydratedConfigs, setWidgetConfigsSyncHook, syncableWidgetConfigs } from '@/lib/widgetStore';
import type { PeriodDays } from '@/lib/period';

const PREFS_KEY = 'pulse_widget_prefs';
const ORDER_KEY = 'pulse_widget_order';
/** Personal Home: the ordered list of pinned widget registry keys (steep «На главную»). Stored
    as an object `{keys:[]}` so it round-trips through the object-only store-row parser. */
const HOME_KEY = 'pulse_home_blocks';

/** Widget footprint on the 6-column group grid: third (2/6) · half (3/6) · full (6/6). */
export type WidgetSize = 'third' | 'half' | 'full';

/** Series bucketing for daily-flow widgets that opt into `seriesOptions`. */
export type SeriesGrain = 'day' | 'week' | 'month';

/** Extra display options threaded into function-form `variants` (grainable series widgets). */
export interface WidgetSeriesOpts {
  grain: SeriesGrain;
  includeToday: boolean;
}

export interface WidgetPrefs {
  /** chart token index 1..6; undefined = brand accent */
  color?: number;
  /** tinted card background in the accent colour */
  tinted?: boolean;
  /** hidden via the menu; restorable from the group's «Скрытые» bar */
  hidden?: boolean;
  /** custom display title (empty/undefined = the built-in one) */
  title?: string;
  /** chosen presentation (a WidgetVariant key); undefined = the first variant */
  variant?: string;
  /** per-widget time window (a PeriodDays preset); undefined = the 30д default */
  period?: PeriodDays;
  /** chosen footprint on the group grid; undefined = the card's defaultSize (else 'half') */
  size?: WidgetSize;
  /** series bucketing (week/month); undefined = day */
  grain?: Exclude<SeriesGrain, 'day'>;
  /** false = drop today's partial point from daily series; undefined = include */
  includeToday?: false;
  /** goal line drawn on the widget's line charts; undefined = none */
  target?: number;
  /** pinned data source (a channel id) for cross-source surfaces (Главная / отчёты);
      undefined = follow the switcher */
  source?: number;
}


/** Read-only snapshot of a widget's stored prefs. Home reads the pre-U6.3a `home-<key>` row to
    migrate a legacy card's saved settings (period/size/title/source/accent/hidden) into its new
    config-driven identity. */
export function getWidgetPrefs(id: string): WidgetPrefs {
  return getPrefs(id);
}

/** Set/clear a widget's hidden flag by id (Home carries a hidden legacy card's flag onto its new
    config-driven ChartSection id during the U6.3a migration). `hidden` lives only in the prefs
    store, not in the WidgetConfig, so it can't ride the config seed. */
export function setWidgetHidden(id: string, hidden: boolean) {
  setPrefs(id, { ...getPrefs(id), hidden: hidden || undefined });
}

// ── Tiny persisted store + pub-sub (widgets and groups stay in sync across surfaces) ──────
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
export function subscribeStore(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// Cached parses of the three store rows, recomputed only when the stored raw string actually
// changed (covers both setPrefs-style writes and the account-hydrate's direct setItem+notify).
// Entry identities are preserved across re-parses (storeIdentity), so the per-widget selector
// hooks below hand useSyncExternalStore the SAME reference until that widget's own slice changes —
// one widget's write re-renders one widget, not every card on the surface.
function parseObjectRow<T>(raw: string | null): Record<string, T> {
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}
const readRaw = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const EMPTY_PREFS: WidgetPrefs = Object.freeze({});
let prefsRaw: string | null | undefined;
let prefsCache: Record<string, WidgetPrefs> = {};
function prefsSnapshot(): Record<string, WidgetPrefs> {
  const raw = readRaw(PREFS_KEY);
  if (raw === prefsRaw) return prefsCache;
  prefsRaw = raw;
  prefsCache = preserveEntryIdentity(prefsCache, parsePrefs({ widgets: parseObjectRow<unknown>(raw) }).widgets ?? {});
  return prefsCache;
}

const EMPTY_ORDER: string[] = [];
let orderRaw: string | null | undefined;
let orderCache: Record<string, string[]> = {};
function orderSnapshot(): Record<string, string[]> {
  const raw = readRaw(ORDER_KEY);
  if (raw === orderRaw) return orderCache;
  orderRaw = raw;
  // Normalize entries at parse time (arrays of strings only) so per-group reads are pure lookups —
  // a getSnapshot must NOT build a fresh array per call or useSyncExternalStore loops (S6.1 lesson).
  const next = parsePrefs({ widgetOrder: parseObjectRow<unknown>(raw) }).widgetOrder ?? {};
  orderCache = preserveEntryIdentity(orderCache, next);
  return orderCache;
}

export function getPrefs(id: string): WidgetPrefs {
  return prefsSnapshot()[id] ?? EMPTY_PREFS;
}

export function setPrefs(id: string, prefs: WidgetPrefs) {
  try {
    const all = { ...prefsSnapshot() };
    // `period` can be 0 («Всё») — a falsy but real value, so test for undefined, not truthiness.
    if (
      !prefs.color &&
      prefs.tinted === undefined &&
      !prefs.hidden &&
      !prefs.title &&
      !prefs.variant &&
      prefs.period === undefined &&
      prefs.size === undefined &&
      prefs.grain === undefined &&
      prefs.includeToday === undefined &&
      prefs.target === undefined &&
      prefs.source === undefined
    )
      delete all[id];
    else all[id] = prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked — customisation is a nicety */
  }
  notify();
  schedulePush();
}

function getGroupOrder(groupId: string): string[] {
  return orderSnapshot()[groupId] ?? EMPTY_ORDER;
}

export function setGroupOrder(groupId: string, ids: string[]) {
  try {
    const map = { ...orderSnapshot(), [groupId]: ids };
    localStorage.setItem(ORDER_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  notify();
  schedulePush();
}

/** Subscribe to ONE widget's prefs: re-renders the caller only when THAT row changes. */
export function useWidgetPrefs(id: string): WidgetPrefs {
  return useSyncExternalStore(
    subscribeStore,
    () => getPrefs(id),
    () => getPrefs(id),
  );
}

/** Subscribe to ONE group's persisted order (stable reference until that group's order changes). */
export function useGroupOrder(groupId: string): string[] {
  return useSyncExternalStore(
    subscribeStore,
    () => getGroupOrder(groupId),
    () => getGroupOrder(groupId),
  );
}

/** Rename one entry of a group's persisted order in place (fromId → toId), keeping its slot. No-op
    when `fromId` isn't stored or `toId` already is — idempotent, so a one-time migration can call it
    safely (U6.3a: a legacy card's section id changes home-<key> → custom-<configId> and its reorder
    slot must follow instead of resetting to the tail). */
export function remapGroupOrder(groupId: string, fromId: string, toId: string) {
  const cur = getGroupOrder(groupId);
  const i = cur.indexOf(fromId);
  if (i < 0 || cur.includes(toId)) return;
  const next = [...cur];
  next[i] = toId;
  setGroupOrder(groupId, next);
}

// ── Personal Home: the pinned-widget list ────────────────────────────────────────────────
// A separate store row (`pulse_home_blocks`) from widget prefs/order: it holds registry KEYS
// (e.g. 'kpi', 'history'), not widget ids, in the order they appear on /home. Same
// localStorage-first + pub-sub + account-sync pattern as prefs/order. The Home surface renders
// each key under a `home-<key>` ChartSection, so a pinned widget's Home arrangement (size /
// title / period / hidden) is a distinct prefs identity from its source-screen copy.
let homeRaw: string | null | undefined;
let homeCache: string[] = [];
export function getHomeBlocks(): string[] {
  const raw = readRaw(HOME_KEY);
  if (raw === homeRaw) return homeCache;
  homeRaw = raw;
  const stored = parseObjectRow<unknown>(raw).keys;
  const next = parsePrefs({ home: stored }).home ?? [];
  homeCache = preserveValueIdentity(homeCache, next);
  return homeCache;
}

export function setHomeBlocks(keys: string[]) {
  try {
    localStorage.setItem(HOME_KEY, JSON.stringify({ keys }));
  } catch {
    /* storage blocked — pinning is a nicety */
  }
  notify();
  schedulePush();
}

/** Pin a widget to Home (append once, keeping the existing order). No-op if already pinned. */
export function pinToHome(key: string) {
  const keys = getHomeBlocks();
  if (keys.includes(key)) return;
  setHomeBlocks([...keys, key]);
}

/** Unpin a widget from Home. */
export function unpinFromHome(key: string) {
  const keys = getHomeBlocks();
  if (!keys.includes(key)) return;
  setHomeBlocks(keys.filter((k) => k !== key));
}

/** Is this registry key currently pinned to Home? */
export function isPinnedToHome(key: string): boolean {
  return getHomeBlocks().includes(key);
}

/** Reactive pinned list (stable reference until the pin set changes — Home reads this). */
export function useHomeBlocks(): string[] {
  return useSyncExternalStore(subscribeStore, getHomeBlocks, getHomeBlocks);
}

/** Subscribe to ONE key's pin state — a boolean snapshot, so an unrelated pin/prefs write never
 *  re-renders this card. Unconditional-hook-safe: undefined (non-pinnable card) is always false. */
export function useIsPinnedToHome(key: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeStore,
    () => (key ? getHomeBlocks().includes(key) : false),
    () => (key ? getHomeBlocks().includes(key) : false),
  );
}

/** Home edit-mode flag. When /home wraps its WidgetGroup in this provider (value=true), every
 *  pinnable card (one carrying a `homeKey`) shows a × affordance in its header that unpins it
 *  from Home. Default false → no edit chrome on any other surface (source screens never wrap it). */
export const HomeEditContext = createContext(false);

// ── Account sync: mirror the widget store into user_prefs (GET/PUT /api/prefs) ────────────
// The store stays localStorage-FIRST (instant reads, works offline / without a DB); the
// server blob makes customisation cross-device. PUT is a full replace, so foreign keys in
// the blob are round-tripped via `serverExtra`. Until the initial GET succeeds we never
// push — a blind push could wipe another device's copy or the blob's foreign keys. Demo
// mode never syncs.
let syncReady = false;
let serverExtra: Record<string, unknown> = {};
let pushTimer: number | null = null;
// Must match the server's PUT /api/prefs guard (server/index.js) so the client degrades BEFORE a 413.
const PREFS_MAX = 32000;

const PrefsBlobSchema = z.object({ prefs: z.unknown().optional().nullable() }).passthrough();

function localBlob() {
  return {
    widgets: prefsSnapshot(),
    widgetOrder: orderSnapshot(),
    // The pinned-Home list rides the SAME account blob under `home` (a plain string[]) — no
    // new endpoint. Destructured OUT of `rest` in the hydrate below so serverExtra never
    // double-carries it.
    home: getHomeBlocks(),
    // The metric-builder's WidgetConfig[] rides the same blob under `widgetConfigs` (its own
    // localStorage-first store); mutations schedule a push via the sync hook registered below. Legacy
    // composites are excluded (device-local, re-derived from the synced Home pins) so they never
    // resurrect on a device that cleared them.
    widgetConfigs: syncableWidgetConfigs(),
  };
}

function schedulePush() {
  // Don't push before the account copy is fetched (a blind push could wipe it) or in demo mode. A
  // widget created in this window is instead recovered by the mount-baseline diff in the hydrate.
  if (!syncReady || isDemoMode()) return;
  if (pushTimer != null) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    pushTimer = null;
    const prefs: Record<string, unknown> = { ...serverExtra, ...localBlob() };
    // If the whole blob would exceed the server cap, drop the builder configs so dashboard LAYOUT
    // keeps syncing (the too-large builder set stays device-local) instead of a 413 killing ALL sync.
    if (JSON.stringify(prefs).length > PREFS_MAX) delete prefs.widgetConfigs;
    void apiSend('PUT', '/api/prefs', { prefs }).catch(() => {
      /* offline / DB off — customisation stays device-local; the next mutation retries */
    });
  }, 1500);
}

/** Hydrate widget prefs/order from the account blob; mount ONCE in the authenticated shell. */
export function useWidgetPrefsSync() {
  useEffect(() => {
    if (isDemoMode()) return;
    let cancelled = false;
    // A LOCAL widget-config mutation mirrors into the account blob (schedulePush is debounced and
    // no-ops until syncReady, so a mutation before hydrate can't blind-push).
    setWidgetConfigsSyncHook(schedulePush);
    // Snapshot the syncable config ids at mount. Any syncable id NOT in this baseline when the GET
    // resolves was created in the fetch window (a genuine raced create) and must survive account-wins;
    // a pre-existing local id IS in the baseline, so account-wins correctly drops it if another device
    // deleted it (no resurrection). Legacy configs are never in the baseline (syncable excludes them).
    const baseline = new Set(syncableWidgetConfigs().map((c) => c.id));
    void apiGet('/api/prefs', PrefsBlobSchema)
      .then(({ prefs }) => {
        if (cancelled) return;
        const { widgets, widgetOrder, home, widgetConfigs, ...rest } = parsePrefs(prefs);
        serverExtra = rest;
        syncReady = true;
        const local = localBlob();
        let pushLocal = false;
        try {
          // The account copy wins (cross-device intent). A device with local customisation
          // but no account copy yet ADOPTS its setup as the account's (first sync).
          if (widgets && typeof widgets === 'object') localStorage.setItem(PREFS_KEY, JSON.stringify(widgets));
          else if (Object.keys(local.widgets).length) pushLocal = true;
          if (widgetOrder && typeof widgetOrder === 'object') localStorage.setItem(ORDER_KEY, JSON.stringify(widgetOrder));
          else if (Object.keys(local.widgetOrder).length) pushLocal = true;
          // Home pinned list: same account-wins rule. Stored under `{keys}` so getHomeBlocks reads it.
          if (Array.isArray(home)) localStorage.setItem(HOME_KEY, JSON.stringify({ keys: home }));
          else if (local.home.length) pushLocal = true;
          // Metric-builder configs: account-wins, but a widget created while the GET was in flight
          // (id absent from the mount `baseline`) is unioned in so it isn't silently deleted, and
          // device-local legacy composites are preserved. hydrateWidgetConfigs notifies its subscribers
          // WITHOUT firing the sync hook (no push-back of the just-hydrated copy); pushBack pushes the
          // genuinely-raced widget up.
          if (Array.isArray(widgetConfigs)) {
            const { seed, pushBack } = reconcileHydratedConfigs(widgetConfigs, baseline);
            hydrateWidgetConfigs(seed);
            if (pushBack) pushLocal = true;
          } else if (local.widgetConfigs.length) {
            pushLocal = true;
          }
        } catch {
          /* storage blocked — server copy just isn't cached locally */
        }
        notify();
        if (pushLocal) schedulePush();
      })
      .catch(() => {
        /* 401 / offline — stay local-only; pushes remain disabled this session */
      });
    return () => {
      cancelled = true;
      setWidgetConfigsSyncHook(null);
      // Reset the module-global sync state so a prior account's push (or preserved foreign keys)
      // can never land on the NEXT account after a logout→login within the same page session.
      syncReady = false;
      serverExtra = {};
      if (pushTimer != null) {
        window.clearTimeout(pushTimer);
        pushTimer = null;
      }
    };
  }, []);
}
