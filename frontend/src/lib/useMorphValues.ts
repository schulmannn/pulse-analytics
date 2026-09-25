import { CHART_MAX_POINTS } from '@/lib/downsample';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { easeChartMorph, resampleSeries } from '@/lib/chartMorph';
import { prefersReducedMotion, readMorphMs } from '@/lib/chartMotionRuntime';

/**
 * VALUE-space UPDATE morph for charts whose geometry is a pure function of a numeric series — bar
 * heights (BarChart, DivergingBars) and radial/pie segment values. The same state machine as
 * MorphingSeries, one dimension down: on a `signature` change the returned array flows from the
 * currently DISPLAYED values to the new target over `--motion-morph` with `--ease-chart-morph`;
 * the consumer recomputes its boxes/arcs from the returned values each frame. Mount, an unchanged
 * signature (resize reflow / referentially-unstable-but-equal refetch) and reduced motion all snap.
 * A signature change mid-morph retargets from the visible values without restarting the clock jump.
 *
 * `mode` picks how a length change matches old→new:
 * - `silhouette` — proportional index mapping ({@link resampleSeries}): a 30→7 bar swap flows each
 *   column from the old silhouette at its position. For x-ordered series (bars over time).
 * - `index` — same index, new slots start from 0: radial/pie segments are categories, where
 *   proportional resampling would blend unrelated categories; a new segment honestly grows in.
 */
export function useMorphValues(
  target: ReadonlyArray<number>,
  signature: string,
  mode: 'silhouette' | 'index',
): ReadonlyArray<number> {
  const [frame, setFrame] = useState<ReadonlyArray<number> | null>(null);

  // `targetRef` gives the RAF loop the live target (a resize mid-morph retargets); `displayedRef`
  // holds the currently RENDERED values so a second period change starts from the visible shape.
  const targetRef = useRef(target);
  targetRef.current = target;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const displayedRef = useRef<ReadonlyArray<number>>(target);
  const sigRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const animRef = useRef<{ from: ReadonlyArray<number>; start: number; dur: number } | null>(null);

  // While idle with an unchanged signature, mirror the target (geometry reflows snap). On a data
  // change we deliberately do NOT overwrite — the effect below captures the OLD values as the start.
  if (animRef.current == null && signature === sigRef.current) {
    displayedRef.current = target;
  }

  const alignRef = useRef<(from: ReadonlyArray<number>, length: number) => ReadonlyArray<number>>(() => []);
  alignRef.current = (from, length) => {
    if (from.length === length) return from;
    return modeRef.current === 'silhouette'
      ? resampleSeries(from, length)
      : Array.from({ length }, (_, i) => from[i] ?? 0);
  };

  const tickRef = useRef<() => void>(() => {});
  tickRef.current = () => {
    const anim = animRef.current;
    if (!anim) {
      rafRef.current = null;
      return;
    }
    const now = performance.now();
    const t = anim.dur <= 0 ? 1 : Math.min((now - anim.start) / anim.dur, 1);
    const e = easeChartMorph(t);
    const to = targetRef.current;
    const from = alignRef.current(anim.from, to.length);
    const cur = to.map((v, i) => from[i] + (v - from[i]) * e);
    displayedRef.current = cur;
    setFrame(cur);
    if (t < 1) {
      rafRef.current = requestAnimationFrame(() => tickRef.current());
    } else {
      animRef.current = null;
      rafRef.current = null;
      displayedRef.current = to;
      // Fall back to the exact target render (byte-identical to the static values).
      setFrame(null);
    }
  };

  useLayoutEffect(() => {
    if (sigRef.current === null) {
      // First mount: no morph (the CSS mount reveal covers entrance). Record the baseline.
      sigRef.current = signature;
      displayedRef.current = target;
      return;
    }
    if (sigRef.current === signature) {
      // Same data, possibly new geometry (a reflow rebuilt the array). A RUNNING morph retargets
      // through targetRef — don't cancel it; idle just mirrors the target.
      if (animRef.current != null) return;
      displayedRef.current = target;
      setFrame(null);
      return;
    }
    sigRef.current = signature;

    // Кап пер-кадровой цены (перф-ревью): метрик-страница НАМЕРЕННО держит bar/rank на полной
    // серии архива (до ~730 колонок на пресете «Всё» — единственная некапнутая поверхность), и
    // пересборка 730 элементов × 60fps × 700мс роняет слабое железо до 15-25fps. Морф суб-пиксельных
    // колонок всё равно нечитаем — такие серии честно снапают на target (как reduced motion).
    if (target.length > CHART_MAX_POINTS || prefersReducedMotion()) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      animRef.current = null;
      displayedRef.current = target;
      setFrame(null);
      return;
    }

    // Start (or restart) the morph from the currently VISIBLE values toward the new target.
    const from = alignRef.current(displayedRef.current, target.length);
    animRef.current = { from, start: performance.now(), dur: readMorphMs() };
    displayedRef.current = from;
    // A layout effect plus this synchronous start frame prevents a one-frame flash of the target
    // shape before the first RAF (canon MorphingSeries).
    setFrame(from);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(() => tickRef.current());
  }, [target, signature]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      animRef.current = null;
    },
    [],
  );

  return frame ?? target;
}
