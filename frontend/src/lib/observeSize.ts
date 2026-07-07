/**
 * Attach a ResizeObserver whose callback is deferred to the next animation frame, and return the
 * cleanup for an effect. Deferring breaks the synchronous measure → setState → re-layout → measure
 * cascade the browser reports as «ResizeObserver loop completed with undelivered notifications» —
 * which, when the measured value oscillates (e.g. a 1px scrollbar toggle inside a chart card),
 * escalates to React error #185 «Maximum update depth exceeded» and trips the widget error boundary.
 * With the rAF hop each burst of observed changes coalesces into ONE frame-batched update instead of
 * a nested-render storm, so a jitter degrades to a harmless one-frame reflow rather than a crash.
 *
 * Measure ONCE synchronously in the caller before calling this, so first paint isn't a frame late.
 * No-op where ResizeObserver is unavailable (SSR / jsdom tests).
 */
export function observeSize(el: Element, measure: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  let handle = 0;
  const ro = new ResizeObserver(() => {
    if (!raf) { measure(); return; }
    cancelAnimationFrame(handle);
    handle = raf(measure);
  });
  ro.observe(el);
  return () => {
    if (raf) cancelAnimationFrame(handle);
    ro.disconnect();
  };
}
