import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import { z } from 'zod';
import { apiGet, apiSend } from '@/api/client';
import { isDemoMode } from '@/lib/demo';
import { fmt } from '@/lib/format';
import { BarChart } from '@/components/BarChart';
import { Breakdown } from '@/components/Breakdown';
import { PieChart } from '@/components/PieChart';
import { DivergingBars } from '@/components/DivergingBars';
import { ChartExpandOverlay, type ChartExpandConfig } from '@/components/ExpandableChart';
import { DEFAULT_WIDGET_DAYS, WidgetPeriodProvider, widgetPeriodValue } from '@/lib/period';
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
    as an object `{keys:[]}` so it round-trips through the existing object-only readJson reader. */
const HOME_KEY = 'pulse_home_blocks';

/** Widget footprint on the 6-column group grid: third (2/6) · half (3/6) · full (6/6). */
export type WidgetSize = 'third' | 'half' | 'full';

interface WidgetPrefs {
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

interface SeriesBarValuesOptions {
  /** Delta series: diverging bars around a zero baseline instead of zero-based columns. */
  diverging?: boolean;
  /** Ledger value formatter (default fmt.num). */
  format?: (v: number) => string;
  /** Ledger rows override — when the list should show something other than the plotted
      values (e.g. subscriber LEVELS beside a delta chart). Default: last 6 points, newest first. */
  ledger?: LedgerRow[];
}

/** The wide «Столбцы + значения» variant for SERIES charts: bars (flex-1) plus a right-hand
    ledger of the LAST 6 points (label → value, newest first). Needs the full grid row. */
export function seriesBarValuesVariant(
  values: number[],
  labels: string[],
  titles: string[],
  opts: SeriesBarValuesOptions = {},
): WidgetVariant {
  const format = opts.format ?? ((v: number) => fmt.num(v));
  const rows =
    opts.ledger ??
    values
      .map((v, i) => ({ label: labels[i] ?? '', value: format(v) }))
      .slice(-6)
      .reverse();
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

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function getPrefs(id: string): WidgetPrefs {
  return readJson<Record<string, WidgetPrefs>>(PREFS_KEY, {})[id] ?? {};
}

function setPrefs(id: string, prefs: WidgetPrefs) {
  try {
    const all = readJson<Record<string, WidgetPrefs>>(PREFS_KEY, {});
    // `period` can be 0 («Всё») — a falsy but real value, so test for undefined, not truthiness.
    if (
      !prefs.color &&
      !prefs.tinted &&
      !prefs.hidden &&
      !prefs.title &&
      !prefs.variant &&
      prefs.period === undefined &&
      prefs.size === undefined
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
  const map = readJson<Record<string, string[]>>(ORDER_KEY, {});
  const list = map[groupId];
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

function setGroupOrder(groupId: string, ids: string[]) {
  try {
    const map = readJson<Record<string, string[]>>(ORDER_KEY, {});
    map[groupId] = ids;
    localStorage.setItem(ORDER_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  notify();
  schedulePush();
}

// ── Personal Home: the pinned-widget list ────────────────────────────────────────────────
// A separate store row (`pulse_home_blocks`) from widget prefs/order: it holds registry KEYS
// (e.g. 'digest', 'history'), not widget ids, in the order they appear on /home. Same
// localStorage-first + pub-sub + account-sync pattern as prefs/order. The Home surface renders
// each key under a `home-<key>` ChartSection, so a pinned widget's Home arrangement (size /
// title / period / hidden) is a distinct prefs identity from its source-screen copy.
export function getHomeBlocks(): string[] {
  const stored = readJson<{ keys?: unknown }>(HOME_KEY, {}).keys;
  return Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : [];
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

/** Re-render on any store change; returns the current pinned list (Home reads this). */
export function useHomeBlocks(): string[] {
  useStoreTick();
  return getHomeBlocks();
}

/** Re-render on any widget-store change (prefs / order). */
function useStoreTick() {
  const [, force] = useState(0);
  useEffect(() => subscribeStore(() => force((n) => n + 1)), []);
}

// ── Account sync: mirror the widget store into user_prefs (GET/PUT /api/prefs) ────────────
// The store stays localStorage-FIRST (instant reads, works offline / without a DB); the
// server blob makes customisation cross-device. PUT is a full replace, so foreign keys in
// the blob are round-tripped via `serverExtra`. Until the initial GET succeeds we never
// push — a blind push could wipe another device's copy or the blob's foreign keys. Demo
// mode never syncs.
let syncReady = false;
let serverExtra: Record<string, unknown> = {};
let pushTimer: number | null = null;

const PrefsBlobSchema = z.object({ prefs: z.record(z.unknown()).nullable() });

function localBlob() {
  return {
    widgets: readJson<Record<string, WidgetPrefs>>(PREFS_KEY, {}),
    widgetOrder: readJson<Record<string, string[]>>(ORDER_KEY, {}),
    // The pinned-Home list rides the SAME account blob under `home` (a plain string[]) — no
    // new endpoint. Destructured OUT of `rest` in the hydrate below so serverExtra never
    // double-carries it.
    home: getHomeBlocks(),
  };
}

function schedulePush() {
  if (!syncReady || isDemoMode()) return;
  if (pushTimer != null) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    pushTimer = null;
    void apiSend('PUT', '/api/prefs', { prefs: { ...serverExtra, ...localBlob() } }).catch(() => {
      /* offline / DB off — customisation stays device-local; the next mutation retries */
    });
  }, 1500);
}

/** Hydrate widget prefs/order from the account blob; mount ONCE in the authenticated shell. */
export function useWidgetPrefsSync() {
  useEffect(() => {
    if (isDemoMode()) return;
    let cancelled = false;
    void apiGet('/api/prefs', PrefsBlobSchema)
      .then(({ prefs }) => {
        if (cancelled) return;
        const { widgets, widgetOrder, home, ...rest } = (prefs ?? {}) as Record<string, unknown>;
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
      el.style.transition = 'transform 260ms cubic-bezier(0.2, 0.7, 0.3, 1)';
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
  // their natural mount order.
  const stored = getGroupOrder(id);
  const registeredIds = registered.map((r) => r.id);
  const sequence = [
    ...stored.filter((x) => registeredIds.includes(x)),
    ...registeredIds.filter((x) => !stored.includes(x)),
  ];
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
    el.style.transition = 'transform 260ms cubic-bezier(0.2, 0.7, 0.3, 1)';
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

  const hidden = registered.filter((r) => getPrefs(r.id).hidden);

  return (
    <GroupCtx.Provider value={{ register, sequence, move, reorderMode, beginReorder, draggingId, dragStart, dragMove, dragEnd }}>
      <div className={className}>{children}</div>
      {reorderMode &&
        createPortal(
          <button
            type="button"
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
  variants?: WidgetVariant[] | ((period: WidgetPeriodValue) => WidgetVariant[]);
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
  /** Body; with `variants` it renders BELOW the active variant (shared captions etc.). */
  children?: ReactNode;
}

export function ChartSection({ id, title, action, variants, className, defaultSize, expand, periodControl, homeKey, children }: ChartSectionProps) {
  const widgetId = id ?? title;
  const group = useContext(GroupCtx);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [expandOpen, setExpandOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  useStoreTick();

  // Depend on the STABLE register callback, not the ctx object (recreated every group
  // render) — otherwise the cleanup/register cycle feeds the group's state in a loop.
  const register = group?.register;
  useEffect(() => register?.(widgetId, title, sectionRef.current), [register, widgetId, title]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const prefs = getPrefs(widgetId);
  const update = (next: WidgetPrefs) => setPrefs(widgetId, next);

  // Personal-Home pin state (only when this card is registered as pinnable via `homeKey`).
  // useStoreTick above already re-renders on any store change, so the read stays live.
  const pinned = homeKey ? isPinnedToHome(homeKey) : false;

  // Per-widget window: the card's own period (default 30д). Charts inside read it via
  // useWidgetPeriod(); the WidgetPeriodProvider below scopes it to this card's subtree.
  // Memoized on the scalar `widgetDays` so `inRange`'s identity is stable across re-renders —
  // consumers key their derive memos on it (a fresh predicate each render would bust them).
  const widgetDays: PeriodDays = prefs.period ?? DEFAULT_WIDGET_DAYS;
  const widgetPeriod = useMemo(() => widgetPeriodValue(widgetDays), [widgetDays]);

  // Resolve variants: the function form recomputes its series for THIS card's window (post-derived
  // charts); the array form is period-agnostic (server-summary / graphs-driven series). Memoized so
  // the (potentially heavy) function form runs once per (variants identity, widget window) — not on
  // every ChartSection re-render (menu open/close, hover, scrollspy, store notify).
  const resolvedVariants = useMemo(
    () => (typeof variants === 'function' ? variants(widgetPeriod) : variants),
    [variants, widgetPeriod],
  );

  const activeVariant =
    resolvedVariants && resolvedVariants.length > 0
      ? (resolvedVariants.find((v) => v.key === prefs.variant) ?? resolvedVariants[0])
      : null;

  // Effective footprint on the 6-col group grid: the user's choice (or the card's defaultSize,
  // else 'half'), clamped UP to the active variant's minSize so a wide bar+ledger presentation
  // never renders in a third. col-span is applied on the OUTER section below.
  const chosenSize: WidgetSize = prefs.size ?? defaultSize ?? 'half';
  const effectiveSize = maxSize(chosenSize, activeVariant?.minSize ?? 'third');

  // The widget's own body — the active variant plus the shared children (captions etc.). Reused
  // as the Tier-1 overlay content: the same chart, just rendered at full explorer axes. Wrapped
  // in the widget-period provider so every chart primitive inside filters to THIS card's window.
  const bodyNode = (
    <WidgetPeriodProvider value={widgetPeriod}>
      {activeVariant ? activeVariant.render : null}
      {children}
    </WidgetPeriodProvider>
  );
  // The «Развернуть» affordance renders on every widget. Tier-2 (a rich `expand` config)
  // drives its own overlay content; Tier-1 falls back to the widget body.
  const hasRichExpand = !!(expand && (expand.renderExpanded || expand.renderExpandedBar || expand.statsFor));

  const seqIndex = group ? group.sequence.indexOf(widgetId) : -1;
  const accentVar = prefs.color ? `--chart-${prefs.color}` : '--brand-iris';
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
  if (prefs.color) (innerStyle as Record<string, string>)['--brand-iris'] = `var(--chart-${prefs.color})`;
  if (prefs.tinted) innerStyle.backgroundColor = `hsl(var(${accentVar}) / 0.07)`;
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

  return (
    <section
      ref={sectionRef}
      className={`${reorder ? 'cursor-grab touch-none select-none active:cursor-grabbing' : ''} ${
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
        className={`rounded-xl border border-border bg-card p-4 sm:p-5 ${reorder ? 'widget-jiggle' : ''} ${
          isDragging ? 'shadow-lg' : ''
        }`}
        style={innerStyle}
      >
      <div className="flex items-center gap-3">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium tracking-wider text-muted-foreground">
          {prefs.title || title}
        </h3>
        {action}
        <button
          type="button"
          aria-label={`Развернуть виджет «${prefs.title || title}»`}
          title="Развернуть"
          onClick={() => setExpandOpen(true)}
          className={`shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground print:hidden ${
            reorder ? 'pointer-events-none opacity-0' : ''
          }`}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className={`relative shrink-0 ${reorder ? 'pointer-events-none opacity-0' : ''}`} ref={menuRef}>
          <button
            type="button"
            aria-label={`Меню виджета «${prefs.title || title}»`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.25" />
              <circle cx="8" cy="8" r="1.25" />
              <circle cx="12.5" cy="8" r="1.25" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-border bg-card p-1.5">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setExpandOpen(true);
                }}
                className={menuItem}
              >
                <MenuIcon kind="expand" /> Развернуть
              </button>
              <div aria-hidden="true" className="mx-1 my-1 h-px bg-border" />
              {group && (
                <>
                  <button
                    type="button"
                    disabled={seqIndex <= 0}
                    onClick={() => {
                      group.move(widgetId, -1);
                    }}
                    className={menuItem}
                  >
                    <MenuIcon kind="up" /> Выше
                  </button>
                  <button
                    type="button"
                    disabled={seqIndex < 0 || seqIndex >= group.sequence.length - 1}
                    onClick={() => {
                      group.move(widgetId, 1);
                    }}
                    className={menuItem}
                  >
                    <MenuIcon kind="down" /> Ниже
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      group.beginReorder();
                    }}
                    className={menuItem}
                  >
                    <MenuIcon kind="drag" /> Переставить
                  </button>
                  <div aria-hidden="true" className="mx-1 my-1 h-px bg-border" />
                </>
              )}
              {/* «На главную» / «Убрать с главной» — only on cards registered as pinnable
                  (they pass a homeKey). Pins/unpins this widget on the personal /home surface. */}
              {homeKey && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    if (pinned) unpinFromHome(homeKey);
                    else pinToHome(homeKey);
                  }}
                  className={menuItem}
                >
                  <MenuIcon kind="home" /> {pinned ? 'Убрать с главной' : 'На главную'}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setEditOpen(true);
                }}
                className={menuItem}
              >
                <MenuIcon kind="edit" /> Изменить
              </button>
              {group && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    update({ ...prefs, hidden: true });
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
        <WidgetPeriodPills
          days={widgetDays}
          onChange={(next) => update({ ...prefs, period: next === DEFAULT_WIDGET_DAYS ? undefined : next })}
          hidden={reorder}
        />
      )}
      <div className={`mt-3 ${reorder ? 'pointer-events-none' : ''}`}>
        {bodyNode}
      </div>
      </div>

      {editOpen && (
        <EditWidgetDialog
          defaultTitle={title}
          prefs={prefs}
          variants={resolvedVariants}
          showPeriod={!!periodControl}
          showSize={!!group}
          defaultSize={defaultSize ?? 'half'}
          minSize={activeVariant?.minSize ?? 'third'}
          onChange={update}
          onClose={() => setEditOpen(false)}
        />
      )}

      {expandOpen && (
        <ChartExpandOverlay
          title={prefs.title || title}
          initialDays={periodControl ? widgetDays : undefined}
          renderExpanded={hasRichExpand ? expand?.renderExpanded : undefined}
          renderExpandedBar={hasRichExpand ? expand?.renderExpandedBar : undefined}
          statsFor={hasRichExpand ? expand?.statsFor : undefined}
          statsSum={expand?.statsSum ?? true}
          onClose={() => setExpandOpen(false)}
        >
          {bodyNode}
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

function EditWidgetDialog({ defaultTitle, prefs, variants, showPeriod, showSize, defaultSize = 'half', minSize = 'third', onChange, onClose }: EditWidgetDialogProps) {
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
        className={`w-full ${variants && variants.length > 1 ? 'max-w-lg' : 'max-w-sm'} rounded-xl border border-border bg-card p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-foreground">Настройка виджета</div>

        {variants && variants.length > 1 && (
          <div className="mt-4">
            <span className="text-2xs tracking-wide text-muted-foreground">Тип виджета</span>
            {/* Live preview cards (steep Edit widget): each variant renders for real, scaled
                down, and inherits the chosen accent/tint so what you pick is what you get. */}
            <div className="mt-2 flex snap-x gap-3 overflow-x-auto pb-1">
              {variants.map((v) => {
                const active = (prefs.variant ?? variants[0].key) === v.key;
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
                    onClick={() => onChange({ ...prefs, variant: v.key === variants[0].key ? undefined : v.key })}
                    className={`w-56 shrink-0 snap-start overflow-hidden rounded-lg border text-left transition-colors ${
                      active ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-ink3/50'
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

        <label className="mt-4 block">
          <span className="text-2xs tracking-wide text-muted-foreground">Заголовок</span>
          <input
            autoFocus
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
