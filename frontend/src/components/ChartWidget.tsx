import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import { BarChart } from '@/components/BarChart';
import { Breakdown } from '@/components/Breakdown';

/**
 * Widget system for charts (steep Home): every chart is a card with a «⋯» menu — reorder
 * (Выше/Ниже within its WidgetGroup, applied via CSS order), Изменить (an edit dialog:
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
}

/** One presentation of a widget's data (line / bar / list …), chosen in the edit dialog. */
export interface WidgetVariant {
  key: string;
  label: string;
  render: ReactNode;
}

interface BreakdownLikeItem {
  label: string;
  value: number;
  display?: string;
  color?: string;
}

/** The common «tint-row list ↔ bar chart» pair for Breakdown-style category data. */
export function breakdownVariants(items: BreakdownLikeItem[]): WidgetVariant[] {
  return [
    { key: 'list', label: 'Список', render: <Breakdown items={items} /> },
    {
      key: 'bar',
      label: 'Столбцы',
      render: (
        <BarChart
          values={items.map((i) => i.value)}
          labels={items.map((i) => i.label)}
          titles={items.map((i) => `${i.label}: ${i.display ?? i.value}`)}
        />
      ),
    },
  ];
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
    if (!prefs.color && !prefs.tinted && !prefs.hidden && !prefs.title && !prefs.variant) delete all[id];
    else all[id] = prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked — customisation is a nicety */
  }
  notify();
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
}

/** Re-render on any widget-store change (prefs / order). */
function useStoreTick() {
  const [, force] = useState(0);
  useEffect(() => subscribeStore(() => force((n) => n + 1)), []);
}

// ── WidgetGroup: a flex/grid container whose ChartSection children can be reordered ───────
interface Registered {
  id: string;
  title: string;
}

interface GroupCtxValue {
  register: (id: string, title: string) => () => void;
  sequence: string[];
  move: (id: string, dir: -1 | 1) => void;
  /** iOS-style drag-and-drop reordering («jiggle mode»). */
  reorderMode: boolean;
  beginReorder: () => void;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  dragOver: (dragId: string, overId: string) => void;
}

const GroupCtx = createContext<GroupCtxValue | null>(null);

interface WidgetGroupProps {
  id: string;
  className?: string;
  children: ReactNode;
}

export function WidgetGroup({ id, className, children }: WidgetGroupProps) {
  const [registered, setRegistered] = useState<Registered[]>([]);
  const [reorderMode, setReorderMode] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Jitter dampener for live drag-over swaps: a cooldown + never immediately reverse the
  // same pair (the reflow puts the swapped widget back under the cursor).
  const lastSwapAt = useRef(0);
  const lastSwapPair = useRef('');
  useStoreTick();

  const register = useCallback((widgetId: string, title: string) => {
    setRegistered((prev) => (prev.some((r) => r.id === widgetId) ? prev : [...prev, { id: widgetId, title }]));
    return () => setRegistered((prev) => prev.filter((r) => r.id !== widgetId));
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

  const move = useCallback(
    (widgetId: string, dir: -1 | 1) => {
      const seq = [...sequence];
      const i = seq.indexOf(widgetId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= seq.length) return;
      [seq[i], seq[j]] = [seq[j], seq[i]];
      setGroupOrder(id, seq);
    },
    [id, sequence],
  );

  // Live reorder while dragging: place the dragged widget at the hovered widget's slot.
  const dragOver = useCallback(
    (dragId: string, overId: string) => {
      if (dragId === overId) return;
      const now = Date.now();
      if (now - lastSwapAt.current < 160) return;
      if (lastSwapPair.current === `${overId}>${dragId}` && now - lastSwapAt.current < 450) return;
      const seq = [...sequence];
      const from = seq.indexOf(dragId);
      const to = seq.indexOf(overId);
      if (from < 0 || to < 0) return;
      seq.splice(from, 1);
      seq.splice(to, 0, dragId);
      setGroupOrder(id, seq);
      lastSwapAt.current = now;
      lastSwapPair.current = `${dragId}>${overId}`;
    },
    [id, sequence],
  );

  const beginReorder = useCallback(() => setReorderMode(true), []);

  const hidden = registered.filter((r) => getPrefs(r.id).hidden);

  return (
    <GroupCtx.Provider value={{ register, sequence, move, reorderMode, beginReorder, draggingId, setDraggingId, dragOver }}>
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
  /** Alternative presentations (line / bar / list) selectable in the edit dialog. */
  variants?: WidgetVariant[];
  /** Extra classes on the card (grid spans etc.). */
  className?: string;
  /** Body; with `variants` it renders BELOW the active variant (shared captions etc.). */
  children?: ReactNode;
}

export function ChartSection({ id, title, action, variants, className, children }: ChartSectionProps) {
  const widgetId = id ?? title;
  const group = useContext(GroupCtx);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useStoreTick();

  // Depend on the STABLE register callback, not the ctx object (recreated every group
  // render) — otherwise the cleanup/register cycle feeds the group's state in a loop.
  const register = group?.register;
  useEffect(() => register?.(widgetId, title), [register, widgetId, title]);

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

  const seqIndex = group ? group.sequence.indexOf(widgetId) : -1;
  const accentVar = prefs.color ? `--chart-${prefs.color}` : '--brand-iris';
  const style: CSSProperties = {};
  if (prefs.color) (style as Record<string, string>)['--brand-iris'] = `var(--chart-${prefs.color})`;
  if (prefs.tinted) style.backgroundColor = `hsl(var(${accentVar}) / 0.07)`;
  if (seqIndex >= 0) style.order = seqIndex;
  if (prefs.hidden) style.display = 'none';

  const reorder = !!group?.reorderMode;
  const isDragging = reorder && group?.draggingId === widgetId;

  const menuItem =
    'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <section
      className={`rounded-xl border border-border bg-card p-4 sm:p-5 ${
        reorder ? `widget-jiggle cursor-grab select-none ${isDragging ? 'opacity-50' : ''}` : ''
      } ${className ?? ''}`}
      style={style}
      draggable={reorder}
      onDragStart={
        reorder
          ? (e) => {
              group?.setDraggingId(widgetId);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', widgetId);
            }
          : undefined
      }
      onDragEnd={reorder ? () => group?.setDraggingId(null) : undefined}
      onDragOver={
        reorder
          ? (e) => {
              const dragId = group?.draggingId;
              if (!dragId || dragId === widgetId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              group?.dragOver(dragId, widgetId);
            }
          : undefined
      }
      onDrop={
        reorder
          ? (e) => {
              e.preventDefault();
              group?.setDraggingId(null);
            }
          : undefined
      }
    >
      <div className="flex items-center gap-3">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium tracking-wider text-muted-foreground">
          {prefs.title || title}
        </h3>
        {action}
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
      <div className={`mt-3 ${reorder ? 'pointer-events-none' : ''}`}>
        {variants && variants.length > 0
          ? (variants.find((v) => v.key === prefs.variant) ?? variants[0]).render
          : null}
        {children}
      </div>

      {editOpen && (
        <EditWidgetDialog
          defaultTitle={title}
          prefs={prefs}
          variants={variants}
          onChange={update}
          onClose={() => setEditOpen(false)}
        />
      )}
    </section>
  );
}

function MenuIcon({ kind }: { kind: 'up' | 'down' | 'edit' | 'hide' | 'drag' }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
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
  onChange: (next: WidgetPrefs) => void;
  onClose: () => void;
}

function EditWidgetDialog({ defaultTitle, prefs, variants, onChange, onClose }: EditWidgetDialogProps) {
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
                      <div className="p-3" style={{ width: 448, transform: 'scale(0.5)', transformOrigin: 'top left' }}>
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
