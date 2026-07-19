/**
 * Attach a ResizeObserver whose callback is deferred to the next animation frame, and return the
 * cleanup for an effect. Deferring breaks the synchronous measure → setState → re-layout → measure
 * cascade the browser reports as «ResizeObserver loop completed with undelivered notifications» —
 * which, when the measured value oscillates (e.g. a 12px scrollbar toggle inside a chart card),
 * escalates to React error #185 «Maximum update depth exceeded» and trips the widget error boundary.
 * With the rAF hop each burst of observed changes coalesces into ONE frame-batched update instead of
 * a nested-render storm — but the hop also mutes the browser's own loop-breaker, so a genuine size
 * oscillation (A→B→A scrollbar flip) degrades into a SILENT 60fps livelock: measure → setState →
 * layout flips the size back → RO fires → next frame, forever. The size gate below breaks that too:
 * it detects the flip pattern and suppresses per-frame delivery, replacing it with one trailing
 * measure after the oscillation dies down, so the loop settles instead of spinning.
 *
 * Measure ONCE synchronously in the caller before calling this, so first paint isn't a frame late.
 * No-op where ResizeObserver is unavailable (SSR / jsdom tests).
 */

export type SizeGateDecision = 'deliver' | 'skip' | 'suppress';

// Sizes within this many px on BOTH axes count as «the same size» — sub-pixel/rounding noise.
const EPSILON_PX = 1;
// The Nth consecutive flip back to the previous size is declared an oscillation.
const FLIP_LIMIT = 3;
// Flips further apart than this are treated as independent (user-driven) resizes, not a livelock —
// a real RO feedback loop flips every frame (~16ms), a human toggling a panel does not.
const FLIP_WINDOW_MS = 250;
// After suppressing, one trailing measure this much later picks up the settled size.
const TRAILING_MEASURE_MS = 500;

/**
 * Pure oscillation detector for observed sizes. Tracks the last two delivered sizes and decides,
 * per observation, whether to deliver it, skip it as noise, or suppress a detected livelock:
 * - 'skip'     — within EPSILON_PX of the LAST delivered size on both axes: nothing changed.
 * - 'suppress' — the size flipped back to the one BEFORE last (A→B→A, EPSILON_PX tolerance)
 *                FLIP_LIMIT times in a row within FLIP_WINDOW_MS of each other: an oscillation.
 * - 'deliver'  — everything else; a size that differs from both remembered sizes also resets
 *                the flip streak (a genuinely new size ends the suspicion).
 * The clock is injectable so tests can drive the flip-window logic deterministically.
 */
export function createSizeGate({ now = () => Date.now() }: { now?: () => number } = {}): {
  shouldDeliver(w: number, h: number): SizeGateDecision;
} {
  // Last delivered size…
  let lastW = Number.NaN;
  let lastH = Number.NaN;
  // …and the delivered size before it (NaN never matches within tolerance).
  let prevW = Number.NaN;
  let prevH = Number.NaN;
  let flips = 0;
  let lastFlipAt = Number.NEGATIVE_INFINITY;

  const near = (a: number, b: number) => Math.abs(a - b) <= EPSILON_PX;

  return {
    shouldDeliver(w: number, h: number): SizeGateDecision {
      // (а) Same as the last delivered size — measurement noise, nothing to deliver.
      if (near(w, lastW) && near(h, lastH)) return 'skip';
      // (б) Flipped BACK to the size before last: count the A→B→A pattern; a rapid streak of
      // FLIP_LIMIT is an oscillation. Suppression does NOT rotate the remembered sizes, so a
      // continuing livelock keeps hitting this branch (re-arming the trailing measure) while the
      // repeating counterpart size keeps hitting (а).
      if (near(w, prevW) && near(h, prevH)) {
        const t = now();
        flips = t - lastFlipAt <= FLIP_WINDOW_MS ? flips + 1 : 1;
        lastFlipAt = t;
        if (flips >= FLIP_LIMIT) return 'suppress';
      } else {
        // (в) A size different from BOTH remembered ones — a real resize; end the suspicion.
        flips = 0;
      }
      prevW = lastW;
      prevH = lastH;
      lastW = w;
      lastH = h;
      return 'deliver';
    },
  };
}

export function observeSize(el: Element, measure: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  const gate = createSizeGate();
  let handle = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const ro = new ResizeObserver((entries) => {
    // Gate on the LAST entry's rounded border-box (fallback: contentRect) — the freshest size.
    // Without an entry (nothing to gate on) fall through to plain delivery.
    const entry = entries[entries.length - 1];
    if (entry) {
      const box = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : undefined;
      const w = Math.round(box ? box.inlineSize : entry.contentRect.width);
      const h = Math.round(box ? box.blockSize : entry.contentRect.height);
      const decision = gate.shouldDeliver(w, h);
      if (decision === 'skip') return;
      if (decision === 'suppress') {
        // Livelock: do NOT keep the per-frame rAF loop alive. One trailing measure after the
        // oscillation quiets down; further suppressed deliveries only push the timer out.
        if (trailing != null) clearTimeout(trailing);
        trailing = setTimeout(() => {
          trailing = null;
          measure();
        }, TRAILING_MEASURE_MS);
        return;
      }
      // A genuine delivery supersedes any pending trailing measure.
      if (trailing != null) {
        clearTimeout(trailing);
        trailing = null;
      }
    }
    if (!raf) {
      measure();
      return;
    }
    cancelAnimationFrame(handle);
    handle = raf(measure);
  });
  ro.observe(el);
  return () => {
    if (raf) cancelAnimationFrame(handle);
    if (trailing != null) clearTimeout(trailing);
    ro.disconnect();
  };
}
