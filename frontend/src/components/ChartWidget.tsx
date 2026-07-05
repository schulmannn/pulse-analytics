import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import type { CSSProperties, ReactNode } from 'react';
import { z } from 'zod';
import { apiGet, apiSend } from '@/api/client';
import { isDemoMode } from '@/lib/demo';
import { fmt } from '@/lib/format';
import { preserveEntryIdentity, preserveValueIdentity } from '@/lib/storeIdentity';
import { hydrateWidgetConfigs, reconcileHydratedConfigs, setWidgetConfigsSyncHook, syncableWidgetConfigs } from '@/lib/widgetStore';
import { BarChart } from '@/components/BarChart';
import { Breakdown } from '@/components/Breakdown';
import { PieChart } from '@/components/PieChart';
import { DivergingBars } from '@/components/DivergingBars';
import { ChartExpandOverlay, ExpandedChartHeightContext, WidgetTargetContext, type ChartExpandConfig } from '@/components/ExpandableChart';
import { WidgetErrorBoundary, ThrowInRender } from '@/components/WidgetErrorBoundary';
import { DEFAULT_WIDGET_DAYS, WidgetPeriodProvider, widgetPeriodValue, useChannelRecency, resolveEffectivePeriod } from '@/lib/period';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { useChannels } from '@/api/queries';
import type { PeriodDays, WidgetPeriodValue } from '@/lib/period';

/**
 * Widget system for charts (steep Home): every chart is a card with a «⋯» menu — reorder
 * (Выше/Ниже within its WidgetGroup, applied via CSS order; or jiggle mode, where the card
 * follows the pointer and siblings FLIP-glide aside), Изменить (an edit dialog:
 * custom title, accent colour, tinted background) and Скрыть (with a restore bar under the
 * group). The accent works by scoping the `--brand-iris` CSS var over the widget subtree,
 * so every chart primitive (LineChart / BarChart / Sparkline / Breakdown) recolours without
 * prop plumbing. Prefs + ordering persist in localStorage.
 *
 * The card surface intentionally supersedes the flat hairline section for CHARTS (owner
 * call, steep pattern); KPI ledgers and tables stay open on the paper canvas.
 */

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

/** Rank the sizes so a variant's `minSize` can clamp the user's choice UP. */
const SIZE_RANK: Record<WidgetSize, number> = { third: 0, half: 1, full: 2 };
/** Effective size = the larger of the user's choice and the active variant's floor. */
function maxSize(a: WidgetSize, b: WidgetSize): WidgetSize {
  return SIZE_RANK[a] >= SIZE_RANK[b] ? a : b;
}
/** col-span on the 6-col grid: third → 2/6, half → 3/6, full → 6/6. */
const SIZE_COL_SPAN: Record<WidgetSize, string> = {
  third: 'lg:col-span-2',
  half: 'lg:col-span-3',
  full: 'lg:col-span-6',
};

/** Fixed card height per size on the ≥lg grid (steep tiles) — so a row never mixes a tall card
    with a short one and the chart body fills the leftover space instead of leaving пустоты.
    `third`/`half` SHARE rows (2/6 + 3/6 pack together), so they lock to ONE exact height and stay
    aligned whatever they hold. `full` spans the whole row — it never shares one, so it needs no
    fixed height and stays content-height (hero KPI grids, post tables and bar+ledger self-size;
    a forced height would only pad short ones). Two half rows (264·2 + gap) clear a ~800px viewport
    under the KPI ledger + tabs. Mobile is single-column — no row-mates — so heights apply from lg up. */
// Fixed at EVERY breakpoint (not just lg): below lg the grid collapses to one column and a card with
// no bounded height let its flex-1 body grow with the chart it measures — a measure→height→content
// feedback loop that ran a chart to tens of thousands of px around ~900px width. A fixed card height
// bounds the body (overflow-y-auto scrolls the surplus), killing the loop on mobile/tablet too.
const SIZE_H: Record<WidgetSize, string> = {
  third: 'h-[264px]',
  half: 'h-[264px]',
  full: '',
};

/** One presentation of a widget's data (line / bar / list …), chosen in the edit dialog. */
export interface WidgetVariant {
  key: string;
  label: string;
  /** Smallest footprint this presentation reads well at — clamps the card's size UP while the
      variant is active (default 'third'). The wide bar+ledger presentations set 'full'. */
  minSize?: WidgetSize;
  render: ReactNode;
}

interface BreakdownLikeItem {
  label: string;
  value: number;
  display?: string;
  color?: string;
}

interface LedgerRow {
  label: string;
  value: string;
}

/** Right-hand value list of the wide «Столбцы + значения» layout (steep Edit widget) —
    hairline rows like Breakdown minus the tint bars. Caps at 8 rows, «+N ещё» when more. */
function ValueLedger({ rows }: { rows: LedgerRow[] }) {
  const shown = rows.slice(0, 8);
  const extra = rows.length - shown.length;
  return (
    <div className="w-56 shrink-0">
      {shown.map((row, i) => (
        <div
          key={i}
          className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0"
        >
          <span className="min-w-0 truncate text-xs text-muted-foreground">{row.label}</span>
          <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">{row.value}</span>
        </div>
      ))}
      {extra > 0 && <div className="pt-1.5 text-2xs text-muted-foreground">+{extra} ещё</div>}
    </div>
  );
}

/** The wide chart+ledger row shared by the «Столбцы + значения» variants. */
function BarValuesLayout({ chart, rows }: { chart: ReactNode; rows: LedgerRow[] }) {
  return (
    <div className="flex items-start gap-5">
      <div className="min-w-0 flex-1">{chart}</div>
      <ValueLedger rows={rows} />
    </div>
  );
}

/** The common «tint-row list ↔ bar chart ↔ pie» set for Breakdown-style category data, plus
    the wide «Столбцы + значения» presentation (bar chart + value ledger, needs the full row). */
export function breakdownVariants(items: BreakdownLikeItem[]): WidgetVariant[] {
  const values = items.map((i) => i.value);
  const labels = items.map((i) => i.label);
  const titles = items.map((i) => `${i.label}: ${i.display ?? i.value}`);
  return [
    { key: 'list', label: 'Список', render: <Breakdown items={items} /> },
    {
      key: 'bar',
      label: 'Столбцы',
      render: <BarChart values={values} labels={labels} titles={titles} />,
    },
    {
      key: 'pie',
      label: 'Круговая',
      render: <PieChart values={values} labels={labels} titles={titles} colors={items.map((i) => i.color)} />,
    },
    {
      key: 'bar-values',
      label: 'Столбцы + значения',
      minSize: 'full',
      render: (
        <BarValuesLayout
          chart={<BarChart values={values} labels={labels} titles={titles} />}
          rows={items.map((i) => ({ label: i.label, value: i.display ?? fmt.num(i.value) }))}
        />
      ),
    },
  ];
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

/** Reorder a variants list so `key` renders as the default (first) presentation. */
export function reorderDefault(variants: WidgetVariant[], key: string): WidgetVariant[] {
  const i = variants.findIndex((v) => v.key === key);
  return i > 0 ? [variants[i], ...variants.slice(0, i), ...variants.slice(i + 1)] : variants;
}

interface SeriesBarValuesOptions {
  /** Delta series: diverging bars around a zero baseline instead of zero-based columns. */
  diverging?: boolean;
  /** Ledger value formatter (default fmt.num). */
  format?: (v: number) => string;
  /** Append «Сумма за период» (flow metrics only — summing levels reads as nonsense). */
  sum?: boolean;
  /** Label for the sum row (e.g. «Δ за период» when the plotted values are deltas). */
  sumLabel?: string;
  /** Extra ledger rows PREPENDED to the stats (e.g. «Сейчас» — the current level beside
      a delta chart). */
  extraRows?: LedgerRow[];
}

/** The wide «Столбцы + значения» variant for SERIES charts: bars (flex-1) plus a right-hand
    SUMMARY ledger (Последнее/Максимум/Минимум/Среднее[, Сумма]) — the side column must add
    what the chart itself can't show, never re-list the same per-day points (steep). */
export function seriesBarValuesVariant(
  values: number[],
  labels: string[],
  titles: string[],
  opts: SeriesBarValuesOptions = {},
): WidgetVariant {
  const format = opts.format ?? ((v: number) => fmt.num(v));
  let rows: LedgerRow[] = opts.extraRows ? [...opts.extraRows] : [];
  if (values.length > 0) {
    const last = values[values.length - 1];
    const max = Math.max(...values);
    const min = Math.min(...values);
    const sum = values.reduce((a, b) => a + b, 0);
    rows = rows.concat([
      { label: 'Последнее', value: format(last) },
      { label: 'Максимум', value: format(max) },
      { label: 'Минимум', value: format(min) },
      { label: 'Среднее', value: format(Math.round(sum / values.length)) },
      ...(opts.sum ? [{ label: opts.sumLabel ?? 'Сумма за период', value: format(sum) }] : []),
    ]);
  }
  return {
    key: 'bar-values',
    label: 'Столбцы + значения',
    minSize: 'full',
    render: (
      <BarValuesLayout
        chart={
          opts.diverging ? (
            <DivergingBars values={values} labels={labels} titles={titles} />
          ) : (
            <BarChart values={values} labels={labels} titles={titles} />
          )
        }
        rows={rows}
      />
    ),
  };
}

// ── Tiny persisted store + pub-sub (widgets and groups stay in sync across surfaces) ──────
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
function subscribeStore(l: () => void): () => void {
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
  prefsCache = preserveEntryIdentity(prefsCache, parseObjectRow<WidgetPrefs>(raw));
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
  const parsed = parseObjectRow<unknown>(raw);
  const next: Record<string, string[]> = {};
  for (const key of Object.keys(parsed)) {
    const list = parsed[key];
    if (Array.isArray(list)) next[key] = list.filter((x): x is string => typeof x === 'string');
  }
  orderCache = preserveEntryIdentity(orderCache, next);
  return orderCache;
}

function getPrefs(id: string): WidgetPrefs {
  return prefsSnapshot()[id] ?? EMPTY_PREFS;
}

function setPrefs(id: string, prefs: WidgetPrefs) {
  try {
    const all = { ...prefsSnapshot() };
    // `period` can be 0 («Всё») — a falsy but real value, so test for undefined, not truthiness.
    if (
      !prefs.color &&
      !prefs.tinted &&
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

function setGroupOrder(groupId: string, ids: string[]) {
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
function useGroupOrder(groupId: string): string[] {
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
// (e.g. 'digest', 'history'), not widget ids, in the order they appear on /home. Same
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
  const next = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : [];
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
function useIsPinnedToHome(key: string | undefined): boolean {
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

const PrefsBlobSchema = z.object({ prefs: z.record(z.unknown()).nullable() });

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
        const { widgets, widgetOrder, home, widgetConfigs, ...rest } = (prefs ?? {}) as Record<string, unknown>;
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

// ── WidgetGroup: a flex/grid container whose ChartSection children can be reordered ───────
interface Registered {
  id: string;
  title: string;
}

interface GroupCtxValue {
  register: (id: string, title: string, node: HTMLElement | null) => () => void;
  sequence: string[];
  move: (id: string, dir: -1 | 1) => void;
  /** iOS-style drag-and-drop reordering («jiggle mode»). */
  reorderMode: boolean;
  beginReorder: () => void;
  draggingId: string | null;
  dragStart: (id: string, e: { clientX: number; clientY: number }) => void;
  dragMove: (e: { clientX: number; clientY: number }) => void;
  dragEnd: () => void;
}

const GroupCtx = createContext<GroupCtxValue | null>(null);

const prefersReducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Read the element's CURRENT translate from the computed style (an in-flight glide keeps
 *  its inline transform for microseconds only — the live value is in the computed matrix). */
function currentTranslate(el: HTMLElement): [number, number] {
  const t = typeof getComputedStyle !== 'undefined' ? getComputedStyle(el).transform : '';
  if (!t || t === 'none') return [0, 0];
  const m = t.match(/^matrix(3d)?\(([^)]+)\)$/);
  if (!m) return [0, 0];
  const p = m[2].split(',').map((n) => parseFloat(n));
  return m[1] ? [p[12] || 0, p[13] || 0] : [p[4] || 0, p[5] || 0];
}

interface WidgetGroupProps {
  id: string;
  className?: string;
  children: ReactNode;
}

export function WidgetGroup({ id, className, children }: WidgetGroupProps) {
  const [registered, setRegistered] = useState<Registered[]>([]);
  const [reorderMode, setReorderMode] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Jitter dampener for live drag-over swaps: a cooldown, plus displaced widgets are
  // untargetable while their glide plays (data-gliding) so a swap can't ping-pong.
  const lastSwapAt = useRef(0);

  // ── FLIP: displaced widgets GLIDE to their new slots instead of teleporting. ────────────
  // The store notifies synchronously BEFORE React re-renders, so that's the moment to
  // snapshot the old positions; the layout effect below inverts and plays after commit.
  const nodes = useRef(new Map<string, HTMLElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const [, force] = useState(0);
  useEffect(
    () =>
      subscribeStore(() => {
        for (const [wid, el] of nodes.current) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0) prevRects.current.set(wid, rect);
        }
        force((n) => n + 1);
      }),
    [],
  );
  // ── Pointer drag (jiggle mode): the card ITSELF follows the pointer. Native HTML5 DnD
  // is deliberately not used — it floats a translucent browser snapshot while the real
  // card sits still in its slot, the exact «тень едет, плашка стоит» artefact.
  const dragRef = useRef<{
    id: string;
    el: HTMLElement;
    /** pointer offset inside the card at grab time */
    grabDX: number;
    grabDY: number;
    /** currently applied translate */
    tx: number;
    ty: number;
    /** latest pointer sample (viewport coords) */
    lastX: number;
    lastY: number;
    startX: number;
    startY: number;
    /** true once past the drag threshold */
    lifted: boolean;
  } | null>(null);
  const edgeScrollTimer = useRef<number | null>(null);
  const stopEdgeScroll = useCallback(() => {
    if (edgeScrollTimer.current !== null) {
      clearInterval(edgeScrollTimer.current);
      edgeScrollTimer.current = null;
    }
  }, []);

  /** Glue the dragged card's visual box to the pointer whatever its CURRENT layout slot
   *  is — live reorders and edge auto-scroll just get absorbed into the translate. */
  const positionDragged = useCallback(() => {
    const d = dragRef.current;
    if (!d || !d.lifted) return;
    const rect = d.el.getBoundingClientRect();
    d.tx = d.lastX - d.grabDX - (rect.left - d.tx);
    d.ty = d.lastY - d.grabDY - (rect.top - d.ty);
    d.el.style.transition = 'none';
    d.el.style.transform = `translate(${d.tx}px, ${d.ty}px)`;
  }, []);

  useLayoutEffect(() => {
    if (prevRects.current.size === 0) return;
    const reduced = prefersReducedMotion();
    for (const [wid, el] of nodes.current) {
      if (wid === dragRef.current?.id) continue; // the dragged card is pointer-glued below
      const prev = prevRects.current.get(wid);
      if (!prev) continue;
      const now = el.getBoundingClientRect();
      if (now.width === 0) continue;
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (!dx && !dy) continue;
      if (reduced) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      void el.offsetHeight; // commit the inverted position before playing
      el.style.transition = 'transform var(--motion-glide) var(--ease-standard)';
      el.style.transform = '';
      el.dataset.gliding = '1';
      const clear = () => {
        el.style.transition = '';
        delete el.dataset.gliding;
        el.removeEventListener('transitionend', clear);
      };
      el.addEventListener('transitionend', clear);
    }
    prevRects.current.clear();
    // a committed reorder may have moved the dragged card's layout slot — re-glue it
    positionDragged();
  });

  const register = useCallback((widgetId: string, title: string, node: HTMLElement | null) => {
    if (node) nodes.current.set(widgetId, node);
    setRegistered((prev) => (prev.some((r) => r.id === widgetId) ? prev : [...prev, { id: widgetId, title }]));
    return () => {
      nodes.current.delete(widgetId);
      setRegistered((prev) => prev.filter((r) => r.id !== widgetId));
    };
  }, []);

  // Exit jiggle mode with Escape, like closing any transient mode.
  useEffect(() => {
    if (!reorderMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setReorderMode(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [reorderMode]);

  // Effective sequence: the persisted order first (registered only), newcomers after, in
  // their natural mount order. Reads THIS group's order slice and memoizes, so the array identity
  // only changes on a real reorder / mount — the memoized ctx value below keys on it, and an
  // unrelated store write (one widget's prefs) no longer re-renders every card via a fresh ctx.
  const stored = useGroupOrder(id);
  const sequence = useMemo(() => {
    const registeredIds = registered.map((r) => r.id);
    return [
      ...stored.filter((x) => registeredIds.includes(x)),
      ...registeredIds.filter((x) => !stored.includes(x)),
    ];
  }, [stored, registered]);
  // Drag callbacks live across renders (pointer capture, edge-scroll interval) — read the
  // sequence through a ref so a mid-drag closure never splices a stale order.
  const sequenceRef = useRef(sequence);
  sequenceRef.current = sequence;

  const move = useCallback(
    (widgetId: string, dir: -1 | 1) => {
      const seq = [...sequenceRef.current];
      const i = seq.indexOf(widgetId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= seq.length) return;
      [seq[i], seq[j]] = [seq[j], seq[i]];
      setGroupOrder(id, seq);
    },
    [id],
  );

  // Live reorder while dragging: place the dragged widget at the hovered widget's slot.
  const dragOver = useCallback(
    (dragId: string, overId: string) => {
      if (dragId === overId) return;
      const now = Date.now();
      if (now - lastSwapAt.current < 160) return;
      const seq = [...sequenceRef.current];
      const from = seq.indexOf(dragId);
      const to = seq.indexOf(overId);
      if (from < 0 || to < 0) return;
      seq.splice(from, 1);
      seq.splice(to, 0, dragId);
      setGroupOrder(id, seq);
      lastSwapAt.current = now;
    },
    [id],
  );

  /** Which card's slot is the pointer over? Geometry over the registered nodes — the
   *  dragged card is skipped, and so are cards whose glide is still playing (their box
   *  is in motion; targeting it would ping-pong the swap). */
  const hitTest = useCallback(() => {
    const d = dragRef.current;
    if (!d || !d.lifted) return;
    for (const [wid, el] of nodes.current) {
      if (wid === d.id || el.dataset.gliding) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (d.lastX >= r.left && d.lastX <= r.right && d.lastY >= r.top && d.lastY <= r.bottom) {
        dragOver(d.id, wid);
        break;
      }
    }
  }, [dragOver]);

  // Edge auto-scroll: HTML5 DnD gave it for free, pointer dragging has to bring its own.
  // An interval (not rAF) on purpose — same code must not wedge headless verification.
  const edgeScroll = useCallback(() => {
    const step = () => {
      const d = dragRef.current;
      if (!d || !d.lifted) return 0;
      const vh = window.innerHeight;
      if (d.lastY < 80) return -Math.ceil((80 - d.lastY) / 5);
      if (d.lastY > vh - 80) return Math.ceil((d.lastY - (vh - 80)) / 5);
      return 0;
    };
    if (!step()) {
      stopEdgeScroll();
      return;
    }
    if (edgeScrollTimer.current !== null) return;
    edgeScrollTimer.current = window.setInterval(() => {
      const dy = step();
      if (!dy) {
        stopEdgeScroll();
        return;
      }
      window.scrollBy(0, dy);
      positionDragged(); // the viewport moved under the pointer — re-glue
      hitTest();
    }, 16);
  }, [stopEdgeScroll, positionDragged, hitTest]);

  const dragStart = useCallback((widgetId: string, e: { clientX: number; clientY: number }) => {
    const el = nodes.current.get(widgetId);
    if (!el) return;
    // Re-grabbing a card mid-glide: freeze it where it visually is and carry on from there.
    const [tx, ty] = currentTranslate(el);
    el.style.transition = 'none';
    el.style.transform = tx || ty ? `translate(${tx}px, ${ty}px)` : '';
    delete el.dataset.gliding;
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      id: widgetId,
      el,
      grabDX: e.clientX - rect.left,
      grabDY: e.clientY - rect.top,
      tx,
      ty,
      lastX: e.clientX,
      lastY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      lifted: false,
    };
  }, []);

  const dragMove = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const d = dragRef.current;
      if (!d) return;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      if (!d.lifted) {
        if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 5) return;
        d.lifted = true;
        d.el.style.zIndex = '30';
        d.el.style.willChange = 'transform';
        setDraggingId(d.id);
      }
      positionDragged();
      hitTest();
      edgeScroll();
    },
    [positionDragged, hitTest, edgeScroll],
  );

  const dragEnd = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    stopEdgeScroll();
    if (!d) return;
    setDraggingId(null);
    const { el } = d;
    const done = () => {
      if (dragRef.current?.el === el) return; // re-grabbed before the glide finished
      el.style.transition = '';
      el.style.zIndex = '';
      el.style.willChange = '';
      delete el.dataset.gliding;
      el.removeEventListener('transitionend', done);
    };
    if ((!d.tx && !d.ty) || prefersReducedMotion()) {
      el.style.transform = '';
      done();
      return;
    }
    // Glide home from wherever the pointer let go (the live reorder already committed).
    el.dataset.gliding = '1';
    void el.offsetHeight;
    el.style.transition = 'transform var(--motion-glide) var(--ease-standard)';
    el.style.transform = '';
    el.addEventListener('transitionend', done);
    window.setTimeout(done, 400); // transitionend can be swallowed (tab switch) — belt & braces
  }, [stopEdgeScroll]);

  const beginReorder = useCallback(() => setReorderMode(true), []);

  // Leaving jiggle mode mid-drag (Escape / «Готово») must land the card, not strand it.
  useEffect(() => {
    if (!reorderMode) dragEnd();
  }, [reorderMode, dragEnd]);
  useEffect(() => stopEdgeScroll, [stopEdgeScroll]);

  // The group shell itself still re-renders on every store notify (the FLIP subscription above) —
  // that keeps this hidden-chips row live and plays the glides. The re-render stays O(1): children
  // are prop elements (identity unchanged → React bails out) and the ctx value below is memoized,
  // so cards re-render only when the sequence / drag state actually changes.
  const hidden = registered.filter((r) => getPrefs(r.id).hidden);

  const ctxValue = useMemo<GroupCtxValue>(
    () => ({ register, sequence, move, reorderMode, beginReorder, draggingId, dragStart, dragMove, dragEnd }),
    [register, sequence, move, reorderMode, beginReorder, draggingId, dragStart, dragMove, dragEnd],
  );

  return (
    <GroupCtx.Provider value={ctxValue}>
      <div className={className}>{children}</div>
      {reorderMode &&
        createPortal(
          <button
            type="button"
            data-reorder-done
            onClick={() => setReorderMode(false)}
            className="btn-pill fixed bottom-6 left-1/2 z-40 -translate-x-1/2 bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Готово
          </button>,
          document.body,
        )}
      {hidden.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground print:hidden">
          <span>Скрытые виджеты:</span>
          {hidden.map((h) => (
            <button
              key={h.id}
              type="button"
              data-widget-chip={h.id}
              onClick={() => setPrefs(h.id, { ...getPrefs(h.id), hidden: undefined })}
              className="rounded-full border border-border px-2 py-0.5 font-medium transition-colors hover:text-foreground"
            >
              {getPrefs(h.id).title || h.title} +
            </button>
          ))}
        </div>
      )}
    </GroupCtx.Provider>
  );
}

// ── The widget card ───────────────────────────────────────────────────────────────────────
const SWATCHES = [1, 2, 3, 4, 5, 6] as const;

interface ChartSectionProps {
  /** Stable widget id for the prefs store; defaults to the title. */
  id?: string;
  title: string;
  /** Extra header controls (e.g. the chart-type switcher) between the title and the menu. */
  action?: ReactNode;
  /**
   * Alternative presentations (line / bar / list) selectable in the edit dialog. Either a static
   * array, or a FUNCTION of the card's own window — post-derived charts pass the function form so
   * their series recompute for THIS card's period (the fn runs with the widget's WidgetPeriodValue).
   */
  variants?: WidgetVariant[] | ((period: WidgetPeriodValue, series: WidgetSeriesOpts) => WidgetVariant[]);
  /** Extra classes on the card (grid spans etc.). */
  className?: string;
  /** Footprint this card takes when the user hasn't chosen one — 'full' for hero/table cards
      that want the whole row, else 'half' (the default). Still clamped up by the active
      variant's minSize. */
  defaultSize?: WidgetSize;
  /** RICH (Tier-2) explorer config for the «Развернуть» overlay: period pills, line↔bar
      toggle, stats strip. Undefined = Tier-1 — the overlay renders the widget's own body
      (active variant or children) at full explorer axes. */
  expand?: ChartExpandConfig;
  /**
   * Opt into the per-widget period control (header pill row + the «Период» segment in the edit
   * dialog). ONLY for cards whose body actually reads useWidgetPeriod() — the wired Overview /
   * TgAnalytics widgets. Off by default so cards that still read the global period (IG / Compare /
   * Posts / metric-page / report) don't grow a dead control.
   */
  periodControl?: boolean;
  /**
   * Personal-Home registry key (e.g. 'digest'). When set, the ⋯ menu grows a «На главную» /
   * «Убрать с главной» toggle that pins/unpins this widget on /home. Pass it on the SOURCE-screen
   * ChartSection so the pin originates where the user browses; the Home render passes the same key
   * (under its `home-<key>` id) so its menu reads «Убрать с главной» for an in-place unpin.
   */
  homeKey?: string;
  /**
   * Opt into the daily-series display options (steep Edit-widget parity): «Грануляция»
   * (день/неделя/месяц), «Включая сегодня» and «Целевой уровень» in the edit dialog. ONLY for
   * cards whose function-form `variants` actually consume the WidgetSeriesOpts argument —
   * otherwise the controls would be dead.
   */
  seriesOptions?: boolean;
  /**
   * Config-driven widgets (the metric builder): the ⋯«Изменить» opens THIS editor (owned by
   * ConfigWidget, writing to a WidgetConfig) instead of the legacy prefs dialog, and the card's
   * accent / background / size come from the config via these overrides rather than the prefs
   * store. Undefined = a normal prefs-driven card (unchanged behaviour).
   */
  configEditor?: {
    open: () => void;
    color?: number;
    tinted?: boolean;
    size?: WidgetSize;
    /** Goal line for the widget's charts (config.target, fixed goals only in S5). */
    target?: number | null;
  };
  /** A custom full-screen explorer for «Развернуть» — when set, it fully replaces the generic
   *  ChartExpandOverlay (config-widgets pass a mutable-config sandbox). Receives a `close` callback. */
  explorer?: (close: () => void) => ReactNode;
  /** A signature of the body's inputs (config-widgets pass their WidgetConfig identity). When it
   *  changes, the per-widget error boundary around the body clears a caught error and re-renders —
   *  so reconfiguring a crashed widget recovers it without a manual «Повторить». */
  bodyResetKey?: unknown;
  /** Body; with `variants` it renders BELOW the active variant (shared captions etc.). */
  children?: ReactNode;
}

export function ChartSection({ id, title, action, variants, className, defaultSize, expand, periodControl, homeKey, seriesOptions, configEditor, explorer, bodyResetKey, children }: ChartSectionProps) {
  const widgetId = id ?? title;
  const group = useContext(GroupCtx);
  const homeEditing = useContext(HomeEditContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // The detail overlay's open state lives in the URL (?detail=<widgetId>) so it is shareable and the
  // browser Back button closes it (steep). Deriving it from searchParams — not local state — means
  // Back / forward / a shared link all Just Work: open pushes a history entry, close replaces it away.
  const [searchParams, setSearchParams] = useSearchParams();
  const expandOpen = searchParams.get('detail') === widgetId;
  const openExpand = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('detail', widgetId);
        return next;
      },
      { replace: false },
    );
  }, [setSearchParams, widgetId]);
  const closeExpand = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('detail');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  const menuRef = useRef<HTMLDivElement>(null);
  // The ⋯ trigger — menu items refocus it when the menu closes under keyboard focus (Escape / item
  // click unmounts the focused item, which would otherwise drop focus to <body>).
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // The chart-body region (flex-1 inside the fixed-height card). We feed its measured pixel
  // height to the charts inside so they fill the tile (steep) — see the effect + fillHeight below.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyH, setBodyH] = useState<number | null>(null);

  // Depend on the STABLE register callback, not the ctx object (recreated every group
  // render) — otherwise the cleanup/register cycle feeds the group's state in a loop.
  const register = group?.register;
  useEffect(() => register?.(widgetId, title, sectionRef.current), [register, widgetId, title]);

  // Measure the body region so the charts inside fill the fixed tile height. The region is flex-1
  // inside a fixed-height card, so its clientHeight IS the space left after header/pills/caption —
  // no per-card height guesswork. A vertical scrollbar (long lists) trims width, never height, so
  // this never feedback-loops. null until measured → charts fall back to their own default height.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // Defensive cap: a tile body is never legitimately taller than ~640px, so an absurd measurement
    // means the card is unbounded and the chart is chasing its own height — feed null (chart falls
    // back to its own default) rather than a runaway value. Belt-and-braces alongside the fixed
    // card height, so no future layout change can reintroduce the feedback loop.
    const measure = () => {
      const h = el.clientHeight;
      setBodyH(h > 0 && h < 640 ? h : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        // APG menu button: Escape returns focus to the trigger (the focused item is unmounting).
        menuBtnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Selector subscriptions (not a whole-store tick): this card re-renders when ITS prefs row or
  // ITS pin state changes — another widget's hide/reorder/edit no longer re-renders every card
  // on the surface (with N cards that was O(N) re-renders × variant recompute per click).
  const prefs = useWidgetPrefs(widgetId);
  const update = (next: WidgetPrefs) => setPrefs(widgetId, next);

  // Personal-Home pin state (only when this card is registered as pinnable via `homeKey`).
  const pinned = useIsPinnedToHome(homeKey);
  // On /home in edit mode, a pinnable card shows a × that removes it from Home.
  const showHomeRemove = homeEditing && !!homeKey;

  // Per-widget window: the card's own period (default 30д). Charts inside read it via
  // useWidgetPeriod(); the WidgetPeriodProvider below scopes it to this card's subtree.
  // Memoized on the scalar `widgetDays` so `inRange`'s identity is stable across re-renders —
  // consumers key their derive memos on it (a fresh predicate each render would bust them).
  const requestedDays: PeriodDays = prefs.period ?? DEFAULT_WIDGET_DAYS;
  // Auto-widen an empty window: when the feed reports the channel's newest data (useChannelRecency)
  // and the requested window holds none of it, show the smallest window that does. Kills the «0 /
  // нет данных» that a dormant or just-connected channel (all posts months old) shows under 7д/30д.
  // No-op when recency is unknown (outside the feed) or the requested window already has data.
  const channelRecency = useChannelRecency();
  const widgetDays: PeriodDays = useMemo(
    () => resolveEffectivePeriod(requestedDays, channelRecency),
    [requestedDays, channelRecency],
  );
  const periodWidened = periodControl === true && widgetDays !== requestedDays;
  const widgetPeriod = useMemo(() => widgetPeriodValue(widgetDays), [widgetDays]);

  // Resolve variants: the function form recomputes its series for THIS card's window (post-derived
  // charts); the array form is period-agnostic (server-summary / graphs-driven series). Memoized so
  // the (potentially heavy) function form runs once per (variants identity, widget window) — not on
  // every ChartSection re-render (menu open/close, hover, scrollspy, store notify).
  // Display options for grainable series widgets — a stable object so the memo below keys on
  // the two scalars, not a fresh literal every render.
  const seriesGrain: SeriesGrain = prefs.grain ?? 'day';
  const seriesIncludeToday = prefs.includeToday !== false;
  const seriesOpts = useMemo<WidgetSeriesOpts>(
    () => ({ grain: seriesGrain, includeToday: seriesIncludeToday }),
    [seriesGrain, seriesIncludeToday],
  );
  // Function-form variants compute from live data (post-derived charts) DURING this render — a throw
  // there escapes ChartSection itself, ABOVE the in-card body boundary (a React boundary can't catch
  // its own parent's render). Catch it here and re-throw it INSIDE that boundary (via ThrowInRender in
  // the body) so a derive crash becomes THIS widget's fallback instead of blanking the app shell; the
  // card chrome and its real col-span survive (activeVariant is null → the section keeps its chosen
  // size). Array-form variants are already built, so they can't throw here.
  const variantResult = useMemo<
    { ok: true; variants: WidgetVariant[] | undefined } | { ok: false; error: unknown }
  >(() => {
    if (typeof variants !== 'function') return { ok: true, variants };
    try {
      return { ok: true, variants: variants(widgetPeriod, seriesOpts) };
    } catch (error) {
      return { ok: false, error };
    }
  }, [variants, widgetPeriod, seriesOpts]);
  const resolvedVariants = variantResult.ok ? variantResult.variants : undefined;

  const activeVariant =
    resolvedVariants && resolvedVariants.length > 0
      ? (resolvedVariants.find((v) => v.key === prefs.variant) ?? resolvedVariants[0])
      : null;

  // The body content, with a failed variant-compute surfaced as a throw INSIDE the body boundary.
  const variantRender = variantResult.ok
    ? activeVariant?.render ?? null
    : <ThrowInRender error={variantResult.error} />;

  // Effective footprint on the 6-col group grid: the user's choice (or the card's defaultSize,
  // else 'half'), clamped UP to the active variant's minSize so a wide bar+ledger presentation
  // never renders in a third. col-span is applied on the OUTER section below.
  // Config-driven cards source accent / background / size from the WidgetConfig (via configEditor)
  // instead of the prefs store; a normal card reads prefs as before.
  const activeColor = configEditor ? configEditor.color : prefs.color;
  const activeTinted = configEditor ? configEditor.tinted : prefs.tinted;
  const activeTarget = configEditor ? (configEditor.target ?? null) : (prefs.target ?? null);
  const chosenSize: WidgetSize = (configEditor ? configEditor.size : prefs.size) ?? defaultSize ?? 'half';
  const effectiveSize = maxSize(chosenSize, activeVariant?.minSize ?? 'third');
  // Height fed to every chart in the body so it fills the tile. Only for the FIXED sizes
  // (third/half); a `full` card is content-height, so it passes null and charts keep their own
  // height (e.g. KpiHero's deliberate 64px mini-sparkline, the metric page's 280px chart).
  const fillHeight = effectiveSize === 'full' ? null : bodyH;

  // The widget's own body — the active variant plus the shared children (captions etc.). Reused
  // as the Tier-1 overlay content: the same chart, just rendered at full explorer axes. Wrapped
  // in the widget-period provider so every chart primitive inside filters to THIS card's window.
  const bodyNode = (
    <WidgetPeriodProvider value={widgetPeriod}>
      <WidgetTargetContext.Provider value={activeTarget}>
        {variantRender}
        {children}
      </WidgetTargetContext.Provider>
    </WidgetPeriodProvider>
  );
  // The «Развернуть» affordance renders on every widget. Tier-2 (a rich `expand` config)
  // drives its own overlay content; Tier-1 falls back to the widget body.
  const hasRichExpand = !!(expand && (expand.renderExpanded || expand.renderExpandedBar || expand.statsFor));

  // Reset signal for the per-widget error boundary around the body: the body's inputs (config
  // signature, active variant, effective window). A fresh array each render is fine — the boundary
  // compares entries by value, so it only clears a caught error when one of these actually changes.
  const bodyResetKeys = [bodyResetKey, activeVariant?.key ?? null, widgetDays];

  const seqIndex = group ? group.sequence.indexOf(widgetId) : -1;
  const accentVar = activeColor ? `--chart-${activeColor}` : '--brand-iris';
  // Split the styles across two layers: the OUTER section owns grid placement + the FLIP
  // translate (set imperatively by WidgetGroup), the INNER div owns the visible card —
  // its jiggle rotation is a CSS animation on `transform` and would stomp the FLIP glide
  // if both lived on one element.
  const outerStyle: CSSProperties = {};
  if (seqIndex >= 0) outerStyle.order = seqIndex;
  if (prefs.hidden) outerStyle.display = 'none';

  const reorder = !!group?.reorderMode;
  const isDragging = reorder && group?.draggingId === widgetId;

  const innerStyle: CSSProperties = {};
  if (activeColor) (innerStyle as Record<string, string>)['--brand-iris'] = `var(--chart-${activeColor})`;
  // Tinted background: a TONAL accent surface (steep-like depth) — a soft top-anchored radial of the
  // accent hue over the card, not a flat colour slab. Hairline-only depth stays intact (no shadow):
  // on the dark canvas it reads as a lit surface, on paper as a quiet accent wash.
  if (activeTinted)
    innerStyle.background = `radial-gradient(120% 90% at 50% 0%, hsl(var(${accentVar}) / 0.15), transparent 62%), hsl(var(--card))`;
  // Entrance stagger: one beat per grid slot, capped so deep feeds don't wait forever.
  (innerStyle as Record<string, string>)['--enter-delay'] = `${Math.min(Math.max(seqIndex, 0), 8) * 35}ms`;
  if (isDragging) {
    // the lifted card stops jiggling and pops slightly (iOS) — the pointer carries it
    innerStyle.animation = 'none';
    innerStyle.transform = 'scale(1.02)';
  } else if (reorder && seqIndex % 2 === 1) {
    // alternate the wobble phase by slot (the old :nth-child(even) died with the 2-layer split)
    innerStyle.animationDuration = '0.37s';
    innerStyle.animationDelay = '0.06s';
  }

  const menuItem =
    'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';
  // Card header affordances (expand / menu / remove) share ONE quiet circular icon-button shape —
  // uniform 28px hit target, hover surface, hover colour set per-button (foreground / destructive).
  const iconBtn =
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted';

  return (
    <section
      ref={sectionRef}
      className={`min-w-0 ${reorder ? 'cursor-grab touch-none select-none active:cursor-grabbing' : ''} ${
        SIZE_COL_SPAN[effectiveSize]
      } ${className ?? ''}`}
      style={outerStyle}
      onPointerDown={
        reorder
          ? (e) => {
              if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
              e.preventDefault();
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* pointer already gone */
              }
              group?.dragStart(widgetId, e);
            }
          : undefined
      }
      onPointerMove={reorder ? (e) => group?.dragMove(e) : undefined}
      onPointerUp={reorder ? () => group?.dragEnd() : undefined}
      onPointerCancel={reorder ? () => group?.dragEnd() : undefined}
    >
      <div
        className={`flex flex-col ${SIZE_H[effectiveSize]} rounded-xl border bg-card p-4 sm:p-5 transition-colors hover:border-ink3/40 ${
          // Softer surface edge in dark (a faint white hairline instead of the hard #2b2b2b box —
          // steep-like "lit surface", less boxed); light mode keeps the full hairline (white cards on
          // paper need it for definition). Edit mode keeps a visible border.
          homeEditing && homeKey ? 'border-ink3/25' : 'border-border dark:border-white/[0.06]'
        } ${reorder ? 'widget-jiggle' : 'widget-enter cursor-pointer'} ${isDragging ? 'shadow-lg' : ''}`}
        style={innerStyle}
        // Whole-card click opens the detail overlay (steep — the whole card is the target, not just
        // the small ↗ button). Guarded so header controls, the drill hero, the chart (its own
        // hover/drill) and any open dialog keep their behaviour, and a reorder drag never triggers it.
        // Mouse convenience ONLY: the card carries no button role/tabIndex — real controls (↗ ⋯ ×)
        // nested inside a role="button" are invalid (axe nested-interactive) and make screen readers
        // announce the whole card as one opaque button. The semantic keyboard/AT path to the same
        // action is the header's labelled «Развернуть виджет …» button.
        onClick={
          reorder
            ? undefined
            : (e) => {
                if ((e.target as HTMLElement).closest('button, a, input, select, label, svg, [role="dialog"]')) return;
                openExpand();
              }
        }
      >
      <div className="flex shrink-0 items-center gap-3">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium tracking-wider text-muted-foreground">
          {prefs.title || title}
        </h3>
        {action}
        {showHomeRemove && (
          <button
            type="button"
            aria-label={`Убрать виджет «${prefs.title || title}» с главной`}
            title="Убрать с главной"
            onClick={() => {
              if (!homeKey) return;
              unpinFromHome(homeKey);
              // The whole card unmounts with this button — park focus on the sticky «Готово»
              // edit toggle so a keyboard user removing several widgets never re-Tabs from the top.
              document.querySelector<HTMLElement>('.edit-toggle')?.focus();
            }}
            className={`${iconBtn} hover:text-destructive ${
              reorder ? 'pointer-events-none invisible' : 'home-remove-enter'
            }`}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <button
          type="button"
          aria-label={`Развернуть виджет «${prefs.title || title}»`}
          title="Развернуть"
          onClick={() => openExpand()}
          className={`${iconBtn} hover:text-foreground print:hidden ${
            showHomeRemove ? 'hidden' : ''
          } ${reorder ? 'pointer-events-none invisible' : ''}`}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className={`relative shrink-0 ${reorder ? 'pointer-events-none invisible' : ''}`} ref={menuRef}>
          <button
            ref={menuBtnRef}
            type="button"
            aria-label={`Меню виджета «${prefs.title || title}»`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((v) => !v)}
            onKeyDown={(e) => {
              // APG menu button: ArrowDown opens the menu and moves focus to its first item.
              if (e.key !== 'ArrowDown') return;
              e.preventDefault();
              if (!menuOpen) setMenuOpen(true);
              requestAnimationFrame(() =>
                menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus(),
              );
            }}
            className={`${iconBtn} hover:text-foreground`}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.25" />
              <circle cx="8" cy="8" r="1.25" />
              <circle cx="12.5" cy="8" r="1.25" />
            </svg>
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label={`Меню виджета «${prefs.title || title}»`}
              className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-border bg-card p-1.5"
              // This dropdown renders INSIDE the now-clickable card; stop clicks on its padding /
              // dividers (non-button dead space) from bubbling to the card and opening the detail
              // overlay while the menu is open.
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                // Arrow/Home/End roving focus over the enabled items (role=menu implies it).
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
                e.preventDefault();
                const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
                if (!items.length) return;
                const i = items.indexOf(document.activeElement as HTMLElement);
                const next =
                  e.key === 'Home' || (e.key === 'ArrowDown' && i < 0)
                    ? 0
                    : e.key === 'End'
                      ? items.length - 1
                      : e.key === 'ArrowDown'
                        ? (i + 1) % items.length
                        : i < 0
                          ? items.length - 1
                          : (i - 1 + items.length) % items.length;
                items[next]?.focus();
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  // Refocus the trigger BEFORE the state change so the detail overlay's focus trap
                  // captures it as opener (and restores to it on close) — the menu item itself
                  // unmounts with the menu.
                  menuBtnRef.current?.focus();
                  setMenuOpen(false);
                  openExpand();
                }}
                className={menuItem}
              >
                <MenuIcon kind="expand" /> Развернуть
              </button>
              <div role="separator" className="mx-1 my-1 h-px bg-border" />
              {group && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={seqIndex <= 0}
                    onClick={() => {
                      group.move(widgetId, -1);
                      // Reaching the first slot flips this item to disabled, which blurs it to
                      // <body> and kills the menu's roving arrows — re-park inside the menu.
                      requestAnimationFrame(() => {
                        if (document.activeElement === document.body)
                          menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
                      });
                    }}
                    className={menuItem}
                  >
                    <MenuIcon kind="up" /> Выше
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={seqIndex < 0 || seqIndex >= group.sequence.length - 1}
                    onClick={() => {
                      group.move(widgetId, 1);
                      requestAnimationFrame(() => {
                        if (document.activeElement === document.body)
                          menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
                      });
                    }}
                    className={menuItem}
                  >
                    <MenuIcon kind="down" /> Ниже
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      group.beginReorder();
                      // Reorder mode hides the card controls (visibility:hidden — unfocusable), so
                      // park focus on the one actionable control: the portaled «Готово» pill.
                      requestAnimationFrame(() =>
                        document.querySelector<HTMLElement>('[data-reorder-done]')?.focus(),
                      );
                    }}
                    className={menuItem}
                  >
                    <MenuIcon kind="drag" /> Переставить
                  </button>
                  <div role="separator" className="mx-1 my-1 h-px bg-border" />
                </>
              )}
              {/* «На главную» / «Убрать с главной» — only on cards registered as pinnable
                  (they pass a homeKey). Pins/unpins this widget on the personal /home surface. */}
              {homeKey && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    menuBtnRef.current?.focus();
                    setMenuOpen(false);
                    if (pinned) unpinFromHome(homeKey);
                    else pinToHome(homeKey);
                    // Unpinning ON /home unmounts this whole card with the just-focused trigger —
                    // park on the sticky edit toggle then (elsewhere the card survives, keep it).
                    requestAnimationFrame(() => {
                      if (!menuBtnRef.current?.isConnected)
                        document.querySelector<HTMLElement>('.edit-toggle')?.focus();
                    });
                  }}
                  className={menuItem}
                >
                  <MenuIcon kind="home" /> {pinned ? 'Убрать с главной' : 'На главную'}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  // Trigger first: the edit dialog's focus trap then records it as opener and
                  // restores focus to this card's ⋯ button when the dialog closes.
                  menuBtnRef.current?.focus();
                  setMenuOpen(false);
                  // Config-driven cards open their own editor (writes to the WidgetConfig).
                  if (configEditor) configEditor.open();
                  else setEditOpen(true);
                }}
                className={menuItem}
              >
                <MenuIcon kind="edit" /> Изменить
              </button>
              {group && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    update({ ...prefs, hidden: true });
                    // The card goes display:none in this commit (focus would blur to <body>) —
                    // park on this widget's restore chip in the «Скрытые виджеты» bar, so Enter
                    // again un-hides it. dataset match instead of a selector: ids are free-form.
                    requestAnimationFrame(() => {
                      const chips = document.querySelectorAll<HTMLElement>('[data-widget-chip]');
                      for (const chip of chips) {
                        if (chip.dataset.widgetChip === widgetId) {
                          chip.focus();
                          return;
                        }
                      }
                    });
                  }}
                  className={menuItem}
                >
                  <MenuIcon kind="hide" /> Скрыть
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Per-widget period — a compact pill row under the header (hidden while reordering / in
          print). Only on wired cards that read useWidgetPeriod(); the global topbar switcher is gone. */}
      {periodControl && (
        <>
          <WidgetPeriodPills
            days={widgetDays}
            onChange={(next) => update({ ...prefs, period: next === DEFAULT_WIDGET_DAYS ? undefined : next })}
            hidden={reorder}
          />
          {periodWidened && !reorder && (
            <p className="mt-1 text-2xs text-muted-foreground print:hidden">
              За {PERIOD_WORD[requestedDays]} данных нет — показано за {PERIOD_WORD[widgetDays]}.
            </p>
          )}
        </>
      )}
      <div className={`mt-3 flex min-h-0 flex-1 flex-col ${reorder ? 'pointer-events-none' : ''}`}>
        <WidgetPeriodProvider value={widgetPeriod}>
          <WidgetTargetContext.Provider value={activeTarget}>
            {/* Chart region — flex-1 eats the tile's leftover height. overflow-hidden (NOT auto): a
                dashboard tile must never grow an inner scrollbar — content adapts to the tile instead
                (charts reserve their below-axis rows so they fit; narrative/heavy widgets take a
                content-height `full` card). fillHeight feeds the leftover height to EVERY chart inside
                (variant or bare children) so they fill; a `full` card passes null, so its charts keep
                their own/explicit height. */}
            <div ref={bodyRef} className="min-h-0 flex-1 overflow-hidden">
              {/* Per-widget boundary: a body crash becomes a calm in-card fallback, the header + ⋯
                  menu survive (so the broken widget can still be hidden / edited), and every sibling
                  widget and the app shell keep rendering. */}
              <WidgetErrorBoundary variant="inline" widgetId={widgetId} label={prefs.title || title} resetKeys={bodyResetKeys}>
                <ExpandedChartHeightContext.Provider value={fillHeight}>
                  {variantResult.ok ? (activeVariant ? activeVariant.render : children) : variantRender}
                </ExpandedChartHeightContext.Provider>
              </WidgetErrorBoundary>
            </div>
            {/* Caption (shared children under a variant — «лучший день» / «пик активности» / totals)
                sits below the chart at its natural height, never squeezed by the fill. */}
            {activeVariant && children != null && <div className="shrink-0">{children}</div>}
          </WidgetTargetContext.Provider>
        </WidgetPeriodProvider>
      </div>
      </div>

      {editOpen && !configEditor && (
        <EditWidgetDialog
          defaultTitle={title}
          prefs={prefs}
          variants={resolvedVariants}
          showPeriod={!!periodControl}
          showSeries={!!seriesOptions}
          showSource={widgetId.startsWith('home-')}
          showSize={!!group}
          defaultSize={defaultSize ?? 'half'}
          minSize={activeVariant?.minSize ?? 'third'}
          onChange={update}
          onClose={() => setEditOpen(false)}
        />
      )}

      {/* Config-widgets pass a mutable-config explorer that fully replaces the generic overlay. */}
      {expandOpen && explorer
        ? explorer(closeExpand)
        : expandOpen && (
            <ChartExpandOverlay
              title={prefs.title || title}
              initialDays={periodControl ? widgetDays : undefined}
              renderExpanded={hasRichExpand ? expand?.renderExpanded : undefined}
              renderExpandedBar={hasRichExpand ? expand?.renderExpandedBar : undefined}
              statsFor={hasRichExpand ? expand?.statsFor : undefined}
              statsSum={expand?.statsSum ?? true}
              grainable={hasRichExpand ? expand?.grainable : undefined}
              onClose={closeExpand}
            >
              <WidgetErrorBoundary variant="inline" widgetId={widgetId} label={prefs.title || title} resetKeys={bodyResetKeys}>
                {bodyNode}
              </WidgetErrorBoundary>
            </ChartExpandOverlay>
          )}
    </section>
  );
}

// ── Per-widget period control ─────────────────────────────────────────────────────────────
const WIDGET_PERIODS: Array<{ days: PeriodDays; label: string }> = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

/** Long-form period words for the auto-widen note («За 7 дней данных нет — показано за всё время»). */
export const PERIOD_WORD: Record<PeriodDays, string> = { 7: '7 дней', 30: '30 дней', 90: '90 дней', 0: 'всё время' };

/** Compact underline-tab period row for one widget card (7д / 30д / 90д / Всё). Same visual
    language as the retired topbar switcher, scoped to this card. Hidden while reordering /
    in print (period is not a print concern). */
function WidgetPeriodPills({
  days,
  onChange,
  hidden,
}: {
  days: PeriodDays;
  onChange: (days: PeriodDays) => void;
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <div role="group" aria-label="Период виджета" className="mt-2 flex items-center gap-3 print:hidden">
      {WIDGET_PERIODS.map((p) => {
        const active = days === p.days;
        return (
          <button
            key={p.days}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(p.days)}
            className={`relative px-0.5 pb-1 pt-0.5 text-2xs font-medium tabular-nums transition-colors ${
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {p.label}
            {active && <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-px bg-primary" />}
          </button>
        );
      })}
    </div>
  );
}

function MenuIcon({ kind }: { kind: 'up' | 'down' | 'edit' | 'hide' | 'drag' | 'expand' | 'home' }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
      {kind === 'expand' && <path d="M5 11 11 5M6.5 5H11v4.5" />}
      {kind === 'home' && (
        <>
          <path d="m2 7 6-5 6 5" />
          <path d="M3.5 6.2V14h9V6.2" />
          <path d="M6.5 14v-4h3v4" />
        </>
      )}
      {kind === 'up' && <path d="m4 10 4-4 4 4" />}
      {kind === 'down' && <path d="m4 6 4 4 4-4" />}
      {kind === 'drag' && (
        <>
          <path d="M8 2v12M2 8h12" />
          <path d="m6 3.5 2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2" />
        </>
      )}
      {kind === 'edit' && <path d="M11.5 2.5a1.8 1.8 0 0 1 2.5 2.5L5.5 13.5l-3 .5.5-3z" />}
      {kind === 'hide' && (
        <>
          <path d="M2 2l12 12" />
          <path d="M6.5 3.8A6.5 6.5 0 0 1 14 8s-.7 1.3-2 2.4M4 5.6C2.7 6.7 2 8 2 8a6.9 6.9 0 0 0 7.5 4.2" />
        </>
      )}
    </svg>
  );
}

// ── Edit dialog (steep «Edit widget»): title + accent + tinted background ─────────────────
interface EditWidgetDialogProps {
  defaultTitle: string;
  prefs: WidgetPrefs;
  variants?: WidgetVariant[];
  /** Show the «Период» segment — only for cards that read useWidgetPeriod() (see periodControl). */
  showPeriod?: boolean;
  /** Show the daily-series options (Грануляция / Включая сегодня / Целевой уровень) —
      only for cards that opted in via `seriesOptions` (their variants consume the opts). */
  showSeries?: boolean;
  /** Show the «Источник» select — cross-source surfaces only (Home cards; the feeds follow
      the switcher by design). */
  showSource?: boolean;
  /** Show the «Размер» segment — only inside a WidgetGroup (a lone card can't be resized). */
  showSize?: boolean;
  /** The card's size when the user hasn't chosen one (defaultSize prop, else 'half'). */
  defaultSize?: WidgetSize;
  /** Active variant's floor — sizes below it are disabled (the variant needs the width). */
  minSize?: WidgetSize;
  onChange: (next: WidgetPrefs) => void;
  onClose: () => void;
}

const SIZE_OPTIONS: Array<{ size: WidgetSize; label: string }> = [
  { size: 'third', label: 'Треть' },
  { size: 'half', label: 'Половина' },
  { size: 'full', label: 'Полный' },
];

// Carousel geometry — must match the Tailwind classes on the cards (w-56, gap-3).
const CAROUSEL_CARD_W = 224;
const CAROUSEL_GAP = 12;

/**
 * Variant picker as a steep-style carousel: live preview cards on a translated track
 * (active card centered, neighbours peeking), ‹ › arrows, dot pagination, pointer swipe.
 * The centered card IS the chosen presentation — arrows/dots/card clicks all select.
 */
function VariantCarousel({
  variants,
  prefs,
  onChange,
}: {
  variants: WidgetVariant[];
  prefs: WidgetPrefs;
  onChange: (prefs: WidgetPrefs) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportW, setViewportW] = useState(0);
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const measure = () => setViewportW(node.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const activeKey = prefs.variant ?? variants[0].key;
  const activeIdx = Math.max(
    0,
    variants.findIndex((v) => v.key === activeKey),
  );
  const select = (i: number) => {
    const next = Math.min(variants.length - 1, Math.max(0, i));
    onChange({ ...prefs, variant: variants[next].key === variants[0].key ? undefined : variants[next].key });
  };

  // Pointer swipe flips to the neighbour; a real drag suppresses the card's click-select.
  const dragStartX = useRef<number | null>(null);
  const dragged = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    dragStartX.current = e.clientX;
    dragged.current = false;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragStartX.current == null) return;
    const delta = e.clientX - dragStartX.current;
    dragStartX.current = null;
    if (Math.abs(delta) > 40) {
      dragged.current = true;
      select(activeIdx + (delta < 0 ? 1 : -1));
    }
  };

  // Center the active card: track shift = half viewport − half card − active offset.
  const offset = viewportW / 2 - CAROUSEL_CARD_W / 2 - activeIdx * (CAROUSEL_CARD_W + CAROUSEL_GAP);

  const arrowCls =
    'absolute top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card/90 text-muted-foreground backdrop-blur transition-colors hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground';

  return (
    <div>
      <div className="relative">
        <button
          type="button"
          aria-label="Предыдущий тип"
          disabled={activeIdx === 0}
          onClick={() => select(activeIdx - 1)}
          className={`${arrowCls} left-1`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
            <path d="m15 6-6 6 6 6" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Следующий тип"
          disabled={activeIdx === variants.length - 1}
          onClick={() => select(activeIdx + 1)}
          className={`${arrowCls} right-1`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
        <div
          ref={viewportRef}
          className="touch-pan-y overflow-hidden"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          <div
            className={`flex gap-3 motion-reduce:transition-none ${
              viewportW > 0 ? 'transition-transform duration-300 ease-out' : ''
            }`}
            style={{ transform: `translateX(${offset}px)` }}
          >
            {variants.map((v, i) => {
              const active = i === activeIdx;
              // Wide (minSize:'full') variants preview at half the scale so the whole
              // chart+ledger row fits the same w-56 preview card.
              const wide = v.minSize === 'full';
              const previewStyle: CSSProperties = {};
              if (prefs.color) (previewStyle as Record<string, string>)['--brand-iris'] = `var(--chart-${prefs.color})`;
              if (prefs.tinted)
                previewStyle.backgroundColor = `hsl(var(${prefs.color ? `--chart-${prefs.color}` : '--brand-iris'}) / 0.07)`;
              return (
                <button
                  key={v.key}
                  type="button"
                  aria-pressed={active}
                  aria-label={`Тип виджета: ${v.label}`}
                  onClick={() => {
                    if (dragged.current) {
                      dragged.current = false;
                      return;
                    }
                    select(i);
                  }}
                  className={`w-56 shrink-0 overflow-hidden rounded-lg border text-left transition-[opacity,transform,border-color] duration-300 motion-reduce:transition-none ${
                    active
                      ? 'border-primary ring-1 ring-primary/40'
                      : 'scale-[0.96] opacity-60 border-border hover:opacity-90'
                  }`}
                >
                  <div aria-hidden="true" className="pointer-events-none h-32 overflow-hidden bg-card" style={previewStyle}>
                    <div
                      className="p-3"
                      style={
                        wide
                          ? { width: 896, transform: 'scale(0.25)', transformOrigin: 'top left' }
                          : { width: 448, transform: 'scale(0.5)', transformOrigin: 'top left' }
                      }
                    >
                      {v.render}
                    </div>
                  </div>
                  <div
                    className={`border-t px-2.5 py-1.5 text-xs font-medium ${
                      active ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground'
                    }`}
                  >
                    {v.label}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {/* Dot pagination — one per presentation, the active one stretched. */}
      <div className="mt-2.5 flex justify-center gap-1.5">
        {variants.map((v, i) => (
          <button
            key={v.key}
            type="button"
            aria-label={`Тип ${i + 1}: ${v.label}`}
            aria-current={i === activeIdx || undefined}
            onClick={() => select(i)}
            className={`h-1.5 rounded-full transition-all motion-reduce:transition-none ${
              i === activeIdx ? 'w-4 bg-primary' : 'w-1.5 bg-border hover:bg-ink3/60'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

const GRAIN_OPTIONS: Array<{ value: SeriesGrain; label: string }> = [
  { value: 'day', label: 'День' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
];

/** «Источник» — pin the widget to a fixed channel (default: follow the switcher). Offered on
    cross-source surfaces (Home); standalone Instagram sources are excluded — the Home catalog
    is TG-data widgets, an IG-only source would render them honestly empty. */
function SourceSelect({ prefs, onChange }: { prefs: WidgetPrefs; onChange: (next: WidgetPrefs) => void }) {
  const channels = useChannels();
  const list = (channels.data?.channels ?? []).filter((c) => c.source !== 'ig');
  return (
    <label className="mt-4 block">
      <span className="text-2xs tracking-wide text-muted-foreground">Источник</span>
      <select
        value={prefs.source ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          onChange({ ...prefs, source: v === '' ? undefined : Number(v) });
        }}
        className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
      >
        <option value="">Как в свитчере</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title || (c.username ? `@${c.username}` : `Канал ${c.id}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

function EditWidgetDialog({ defaultTitle, prefs, variants, showPeriod, showSeries, showSource, showSize, defaultSize = 'half', minSize = 'third', onChange, onClose }: EditWidgetDialogProps) {
  // Modal focus contract. The trap's effect must run BEFORE the title-focus effect (declaration
  // order) so it snapshots the real opener; an `autoFocus` attribute would fire during commit —
  // before the trap — corrupting the opener snapshot and then losing focus to panel.focus().
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useFocusTrap(panelRef);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Настройка виджета «${prefs.title || defaultTitle}»`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`max-h-[85vh] w-full ${variants && variants.length > 1 ? 'max-w-lg' : 'max-w-sm'} overflow-y-auto rounded-xl border border-border bg-card p-5 focus:outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-foreground">Настройка виджета</div>

        {variants && variants.length > 1 && (
          <div className="mt-4">
            <span className="text-2xs tracking-wide text-muted-foreground">Тип виджета</span>
            {/* Live preview cards on a steep-style carousel: the centered card is the active
                presentation; each renders for real, scaled down, and inherits accent/tint. */}
            <div className="mt-2">
              <VariantCarousel variants={variants} prefs={prefs} onChange={onChange} />
            </div>
          </div>
        )}

        {showSize && (
          <div className="mt-4">
            <span className="text-2xs tracking-wide text-muted-foreground">Размер</span>
            {/* Треть / Половина / Полный on the 6-col grid. Selecting the card's defaultSize
                clears the pref (fall back to the default). Sizes below the active variant's
                floor are disabled — that presentation needs the width. */}
            <div className="mt-2 flex overflow-hidden rounded border border-border">
              {(() => {
                // Highlight the EFFECTIVE size (a full-only variant clamps the card up even when
                // the stored/default is smaller) — never a disabled button that the card ignores.
                const chosen = prefs.size ?? defaultSize;
                const shownSize = SIZE_RANK[chosen] < SIZE_RANK[minSize] ? minSize : chosen;
                return SIZE_OPTIONS.map((o) => {
                const active = shownSize === o.size;
                const disabled = SIZE_RANK[o.size] < SIZE_RANK[minSize];
                return (
                  <button
                    key={o.size}
                    type="button"
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => onChange({ ...prefs, size: o.size === defaultSize ? undefined : o.size })}
                    className={`flex-1 border-r border-border px-2 py-1.5 text-xs font-medium transition-colors last:border-r-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                      active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    {o.label}
                  </button>
                );
                });
              })()}
            </div>
          </div>
        )}

        {showSource && <SourceSelect prefs={prefs} onChange={onChange} />}

        <label className="mt-4 block">
          <span className="text-2xs tracking-wide text-muted-foreground">Заголовок</span>
          <input
            ref={titleRef}
            value={prefs.title ?? ''}
            placeholder={defaultTitle}
            onChange={(e) => onChange({ ...prefs, title: e.target.value || undefined })}
            className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
          />
        </label>

        {showPeriod && (
          <div className="mt-4">
            <span className="text-2xs tracking-wide text-muted-foreground">Период</span>
            {/* Presets only for now (per-widget custom range is a noted follow-up). Selecting the
                30д default clears the pref so the card falls back to the module default. */}
            <div className="mt-2 flex overflow-hidden rounded border border-border">
              {WIDGET_PERIODS.map((p) => {
                const active = (prefs.period ?? DEFAULT_WIDGET_DAYS) === p.days;
                return (
                  <button
                    key={p.days}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onChange({ ...prefs, period: p.days === DEFAULT_WIDGET_DAYS ? undefined : p.days })}
                    className={`flex-1 border-r border-border px-2 py-1.5 text-xs font-medium tabular-nums transition-colors last:border-r-0 ${
                      active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {showSeries && (
          <div className="mt-4">
            <span className="text-2xs tracking-wide text-muted-foreground">Грануляция</span>
            {/* Bucket the daily series by week/month (sums). День clears the pref. */}
            <div className="mt-2 flex overflow-hidden rounded border border-border">
              {GRAIN_OPTIONS.map((g) => {
                const active = (prefs.grain ?? 'day') === g.value;
                return (
                  <button
                    key={g.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onChange({ ...prefs, grain: g.value === 'day' ? undefined : g.value })}
                    className={`flex-1 border-r border-border px-2 py-1.5 text-xs font-medium transition-colors last:border-r-0 ${
                      active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    {g.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {showSeries && (
          <label className="mt-4 block">
            <span className="text-2xs tracking-wide text-muted-foreground">Целевой уровень</span>
            {/* Draws a dashed goal line on the widget's line charts. Empty = none. */}
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={prefs.target ?? ''}
              placeholder="нет"
              onChange={(e) => {
                const raw = e.target.value.trim();
                const num = raw === '' ? undefined : Number(raw);
                onChange({ ...prefs, target: num !== undefined && Number.isFinite(num) && num > 0 ? num : undefined });
              }}
              className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
            />
          </label>
        )}

        {showSeries && (
          <button
            type="button"
            role="switch"
            aria-checked={prefs.includeToday !== false}
            onClick={() => onChange({ ...prefs, includeToday: prefs.includeToday === false ? undefined : false })}
            className="mt-4 flex w-full items-center justify-between gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>Включая сегодня</span>
            <span
              aria-hidden="true"
              className={
                prefs.includeToday !== false
                  ? 'rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary'
                  : 'rounded-full border border-border px-2 py-0.5 text-2xs font-medium text-muted-foreground'
              }
            >
              {prefs.includeToday !== false ? 'вкл' : 'выкл'}
            </span>
          </button>
        )}

        <div className="mt-4">
          <span className="text-2xs tracking-wide text-muted-foreground">Акцент</span>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              aria-label="Стандартный акцент"
              aria-pressed={!prefs.color}
              onClick={() => onChange({ ...prefs, color: undefined })}
              className={`h-5 w-5 rounded-full transition-shadow ${!prefs.color ? 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-card' : ''}`}
              style={{ backgroundColor: 'hsl(var(--primary))' }}
            />
            {SWATCHES.map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`Акцент ${n}`}
                aria-pressed={prefs.color === n}
                onClick={() => onChange({ ...prefs, color: n })}
                className={`h-5 w-5 rounded-full transition-shadow ${prefs.color === n ? 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-card' : ''}`}
                style={{ backgroundColor: `hsl(var(--chart-${n}))` }}
              />
            ))}
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={!!prefs.tinted}
          onClick={() => onChange({ ...prefs, tinted: !prefs.tinted })}
          className="mt-4 flex w-full items-center justify-between gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <span>Цветной фон</span>
          <span
            aria-hidden="true"
            className={
              prefs.tinted
                ? 'rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary'
                : 'rounded-full border border-border px-2 py-0.5 text-2xs font-medium text-muted-foreground'
            }
          >
            {prefs.tinted ? 'вкл' : 'выкл'}
          </span>
        </button>

        <div className="mt-5 flex items-center justify-between border-t border-border pt-3">
          <button
            type="button"
            onClick={() => onChange({ hidden: prefs.hidden })}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Сбросить
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn-pill bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Готово
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
