import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { observeSize } from '@/lib/observeSize';
import { getPrefs, setGroupOrder, setPrefs, subscribeStore, useGroupOrder } from '@/lib/widgetPrefsStore';

// ── WidgetGroup: a flex/grid container whose ChartSection children can be reordered ───────
export interface Registered {
  id: string;
  title: string;
}

export interface GroupCtxValue {
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

export const GroupCtx = createContext<GroupCtxValue | null>(null);

export const prefersReducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Read the element's CURRENT translate from the computed style (an in-flight glide keeps
 *  its inline transform for microseconds only — the live value is in the computed matrix). */
export function currentTranslate(el: HTMLElement): [number, number] {
  const t = typeof getComputedStyle !== 'undefined' ? getComputedStyle(el).transform : '';
  if (!t || t === 'none') return [0, 0];
  const m = t.match(/^matrix(3d)?\(([^)]+)\)$/);
  if (!m) return [0, 0];
  const p = m[2].split(',').map((n) => parseFloat(n));
  return m[1] ? [p[12] || 0, p[13] || 0] : [p[4] || 0, p[5] || 0];
}

export interface WidgetGroupProps {
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
  const glideSequence = useRef(0);

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
  // ── Дырозатыкание: одинокая карточка в ПОСЛЕДНЕМ ряду растягивается на весь ряд ──────────
  // Хвостовая дыра (half-виджет + пустые колонки до края) читается как сломанная сетка — ряд не
  // должен уметь так выглядеть, даже если юзер сам ресайзнул (визуальный аудит). Прямой DOM-стиль
  // вместо state: ни ре-рендеров, ни риска #185; rAF-хоп по паттерну observeSize. Каждый прогон
  // сначала СНИМАЕТ прошлую растяжку, меряет честный layout и решает заново — идемпотентно.
  const groupRootRef = useRef<HTMLDivElement>(null);
  const stretchedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let handle = 0;
    const apply = () => {
      const root = groupRootRef.current;
      if (!root) return;
      if (stretchedRef.current) {
        stretchedRef.current.style.gridColumn = '';
        stretchedRef.current = null;
      }
      const els = [...nodes.current.values()].filter((el) => el.isConnected && el.offsetWidth > 0);
      if (els.length < 2) return;
      const maxTop = Math.max(...els.map((el) => el.offsetTop));
      const lastRow = els.filter((el) => el.offsetTop === maxTop);
      if (lastRow.length === 1 && lastRow[0].offsetWidth < root.clientWidth * 0.8) {
        lastRow[0].style.gridColumn = '1 / -1';
        stretchedRef.current = lastRow[0];
      }
    };
    const schedule = () => {
      cancelAnimationFrame(handle);
      handle = requestAnimationFrame(apply);
    };
    schedule();
    const unsub = subscribeStore(schedule); // ресайз/скрытие виджета → пере-раскладка
    window.addEventListener('resize', schedule);
    // Данные доезжают ПОСЛЕ маунта и меняют высоты карточек БЕЗ notify стора — одноразовый прогон
    // на скелетонах примет решение по неверному layout'у (прод-находка). Рост/сжатие корня группы
    // = единственный надёжный сигнал «раскладка изменилась» → пере-меряем.
    const unobserve = groupRootRef.current ? observeSize(groupRootRef.current, schedule) : undefined;
    return () => {
      cancelAnimationFrame(handle);
      unsub();
      unobserve?.();
      window.removeEventListener('resize', schedule);
    };
  }, [registered]);

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
      const glideToken = String(++glideSequence.current);
      el.dataset.gliding = glideToken;
      let fallback = 0;
      const clear = () => {
        window.clearTimeout(fallback);
        el.removeEventListener('transitionend', clear);
        // A newer FLIP may have started on this element before this callback ran. Only that newer
        // animation may settle its own styles.
        if (el.dataset.gliding !== glideToken) return;
        el.style.transition = '';
        el.style.transform = '';
        delete el.dataset.gliding;
      };
      el.addEventListener('transitionend', clear);
      // transitionend is not guaranteed when a migration happens in a background/hidden tab.
      // Bound the inverted state so a swallowed event can never leave cards permanently overlapped.
      fallback = window.setTimeout(clear, 400);
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
      <div ref={groupRootRef} className={className}>{children}</div>
      {reorderMode &&
        createPortal(
          <button
            type="button"
            data-reorder-done
            onClick={() => setReorderMode(false)}
            className="btn-pill fixed bottom-6 left-1/2 z-popover -translate-x-1/2 bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
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
