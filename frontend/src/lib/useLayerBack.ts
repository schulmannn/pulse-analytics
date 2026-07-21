import { useEffect, useRef } from 'react';

/**
 * Browser BACK closes the layer instead of leaving the page.
 *
 * Every full-screen layer (detail overlay, post modal, mobile sheet) mounts a history SENTINEL:
 * pressing Back (or the phone's back gesture — the primary «close anything» affordance on mobile)
 * fires popstate, which calls `onClose` — the user stays on the page, one layer down. Every other
 * way of closing (Esc, ×, backdrop, a programmatic close) unmounts the layer, and the deferred
 * cleanup consumes the sentinel with `history.back()` so the NEXT Back is never a dead press.
 *
 * StrictMode-safe: dev double-mount reuses the same instance id — the remount sees its own
 * sentinel (no second push), and the deferred cleanup skips the pop because the id is live again.
 * Stacked layers (a modal over an overlay) each push their own sentinel — plain LIFO.
 *
 * Mount the hook in the layer component itself (it renders only while open), passing the SAME
 * close handler the × button uses.
 */

/** Ids of currently-mounted layers — lets the deferred cleanup tell a real unmount from a
    StrictMode dev remount (the remount re-registers the id before the timeout runs). */
const liveLayers = new Set<string>();
let layerSeq = 0;

export function useLayerBack(onClose: () => void) {
  const idRef = useRef<string | undefined>(undefined);
  if (!idRef.current) idRef.current = `layer-${++layerSeq}`;
  // The latest close handler without re-running the history effect (parents re-create closures).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const id = idRef.current as string;
    liveLayers.add(id);
    // Guarded push: on a StrictMode remount (or an out-of-order re-run) our sentinel is already
    // the top entry — pushing again would need TWO Backs to close.
    if ((window.history.state as { __layer?: string } | null)?.__layer !== id) {
      window.history.pushState({ __layer: id }, '');
    }
    let consumed = false;
    const onPop = () => {
      // Any pop while this layer is topmost closes it — whether the entry popped was ours or the
      // user jumped further back in history (the layer must never survive a location change).
      consumed = true;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      liveLayers.delete(id);
      if (consumed) return;
      // Closed by Esc/×/backdrop/programmatically: consume the sentinel so the stack stays clean.
      // Deferred one tick — a StrictMode remount re-adds the id first and the pop is skipped.
      window.setTimeout(() => {
        if (!liveLayers.has(id) && (window.history.state as { __layer?: string } | null)?.__layer === id) {
          window.history.back();
        }
      }, 0);
    };
    // The layer component renders only while open, so mount/unmount IS the open/close lifecycle.
  }, []);
}
