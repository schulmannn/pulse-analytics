import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildSeriesPaths, easeStandard, interpolatePoints, resamplePoints, type MorphPoint } from '@/lib/chartMorph';

/**
 * The UPDATE-morph data layer for {@link LineChart}. Isolated in its OWN component so the RAF loop's
 * per-frame setState re-renders only the four series paths — never the parent chart (axes, labels,
 * gridlines, hover geometry all stay in the parent's memoized layers). On a data/period change the
 * primary + comparison line/area interpolate continuously from the previously rendered geometry to
 * the new geometry (Recharts-style, proportional point matching). An idle width-only reflow snaps;
 * one arriving during a data morph retargets that morph without restarting it. Reduced motion always
 * snaps. See frontend/DESIGN_TOKENS.md «Chart motion».
 */
export interface MorphGeom {
  /** Primary series points (length = values.length), `y === null` at gap days. */
  primary: MorphPoint[];
  /** Comparison / previous-period points, or null when no comparison is shown. */
  ghost: MorphPoint[] | null;
  /** Baseline y (plot bottom) each area segment closes to. */
  baseY: number;
}

interface MorphingSeriesProps {
  geom: MorphGeom;
  /** Stable DATA signature (seriesMotionKey). A change = a real data/period swap → morph; an
      unchanged signature with new geometry = a resize → snap. */
  signature: string;
  primaryGradientId: string;
  comparisonGradientId: string;
  /** `comparison` appearance: comparison gets its own solid smooth area + solid stroke. */
  comparison: boolean;
  /** Rich hosts (rhea/comparison) use a softer 2px primary stroke vs the 2.5px default. */
  richStyle: boolean;
}

type SeriesPaths = { line: string; area: string };
type FramePaths = { primary: SeriesPaths; ghost: SeriesPaths | null };

function samePoints(a: ReadonlyArray<MorphPoint> | null, b: ReadonlyArray<MorphPoint> | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((point, index) => point.x === b[index].x && point.y === b[index].y);
}

function sameGeometry(a: MorphGeom, b: MorphGeom): boolean {
  return a.baseY === b.baseY && samePoints(a.primary, b.primary) && samePoints(a.ghost, b.ghost);
}

/** Morph duration — mirrors the `--motion-morph` token (RAF can't read the CSS var mid-loop). */
const MORPH_MS_FALLBACK = 700;
function readMorphMs(): number {
  if (typeof window === 'undefined') return MORPH_MS_FALLBACK;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion-morph');
  const ms = Number.parseFloat(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : MORPH_MS_FALLBACK;
}
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function MorphingSeries({
  geom,
  signature,
  primaryGradientId,
  comparisonGradientId,
  comparison,
  richStyle,
}: MorphingSeriesProps) {
  // Idle / settled paths — recomputed only when the geometry object changes (a data swap or a
  // resize), never per frame. During a morph we render `framePaths` instead.
  const targetPaths = useMemo<FramePaths>(
    () => ({
      primary: buildSeriesPaths(geom.primary, geom.baseY),
      ghost: geom.ghost ? buildSeriesPaths(geom.ghost, geom.baseY) : null,
    }),
    [geom],
  );

  const [framePaths, setFramePaths] = useState<FramePaths | null>(null);

  // `geomRef` gives the RAF loop the live target (so a resize mid-morph retargets); `displayedRef`
  // holds the currently RENDERED geometry so a second period change starts from the visible shape.
  const geomRef = useRef(geom);
  geomRef.current = geom;
  const effectGeomRef = useRef(geom);
  const displayedRef = useRef<{ primary: MorphPoint[]; ghost: MorphPoint[] | null }>({
    primary: geom.primary,
    ghost: geom.ghost,
  });
  const sigRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const animRef = useRef<{ fromP: MorphPoint[]; fromG: MorphPoint[] | null; start: number; dur: number } | null>(null);

  // Mirror the rendered geometry into `displayedRef` while IDLE and only when the signature is
  // unchanged (a resize reflow). On a data change (signature differs from `sigRef`) we deliberately
  // do NOT overwrite it — the effect below must capture the OLD visible shape as the morph's start.
  if (animRef.current == null && signature === sigRef.current) {
    displayedRef.current = { primary: geom.primary, ghost: geom.ghost };
  }

  const tickRef = useRef<() => void>(() => {});
  tickRef.current = () => {
    const anim = animRef.current;
    if (!anim) {
      rafRef.current = null;
      return;
    }
    const now = performance.now();
    const t = anim.dur <= 0 ? 1 : Math.min((now - anim.start) / anim.dur, 1);
    const e = easeStandard(t);
    const target = geomRef.current;
    const fromP = resamplePoints(anim.fromP, target.primary.length);
    const curP = interpolatePoints(fromP, target.primary, e);
    let curG: MorphPoint[] | null = null;
    if (anim.fromG && target.ghost) {
      curG = interpolatePoints(resamplePoints(anim.fromG, target.ghost.length), target.ghost, e);
    } else if (target.ghost) {
      // Comparison appeared with no prior shape to grow from — snap it in while the primary morphs.
      curG = target.ghost;
    }
    displayedRef.current = { primary: curP, ghost: curG };
    setFramePaths({
      primary: buildSeriesPaths(curP, target.baseY),
      ghost: curG ? buildSeriesPaths(curG, target.baseY) : null,
    });
    if (t < 1) {
      rafRef.current = requestAnimationFrame(() => tickRef.current());
    } else {
      animRef.current = null;
      rafRef.current = null;
      displayedRef.current = { primary: target.primary, ghost: target.ghost };
      // Fall back to the exact target render (byte-identical to the static geometry).
      setFramePaths(null);
    }
  };

  useLayoutEffect(() => {
    const previousGeom = effectGeomRef.current;
    effectGeomRef.current = geom;
    if (sigRef.current === null) {
      // First mount: no morph (the CSS mount reveal covers entrance). Record the baseline.
      sigRef.current = signature;
      displayedRef.current = { primary: geom.primary, ghost: geom.ghost };
      return;
    }
    if (sigRef.current === signature) {
      // Parents may rebuild equal arrays after a query settles. Equal rendered coordinates are not
      // a resize and must not cancel an in-flight morph.
      if (sameGeometry(previousGeom, geom)) return;
      // Same data, DIFFERENT geometry = a width/height reflow (ResizeObserver). If a morph is RUNNING,
      // do NOT cancel it — the RAF tick reads the live target through geomRef and retargets, so a
      // reflow that lands right after a period change (the y-gutter width shifting as the axis labels
      // change) can't cut the morph short. If idle, snap: targetPaths already reflects the new
      // geometry, so layout reflows immediately without a data morph.
      if (animRef.current != null) return;
      displayedRef.current = { primary: geom.primary, ghost: geom.ghost };
      setFramePaths(null);
      return;
    }
    sigRef.current = signature;

    if (prefersReducedMotion()) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      animRef.current = null;
      displayedRef.current = { primary: geom.primary, ghost: geom.ghost };
      setFramePaths(null);
      return;
    }

    // Start (or restart) the morph from the currently VISIBLE geometry toward the new target.
    const fromP = resamplePoints(displayedRef.current.primary, geom.primary.length);
    const fromG = displayedRef.current.ghost && geom.ghost
      ? resamplePoints(displayedRef.current.ghost, geom.ghost.length)
      : geom.ghost;
    animRef.current = {
      fromP,
      fromG,
      start: performance.now(),
      dur: readMorphMs(),
    };
    displayedRef.current = { primary: fromP, ghost: fromG };
    // A layout effect plus this synchronous start frame prevents a one-frame flash of the target
    // shape before the first RAF. React flushes the update before the browser paints.
    setFramePaths({
      primary: buildSeriesPaths(fromP, geom.baseY),
      ghost: fromG ? buildSeriesPaths(fromG, geom.baseY) : null,
    });
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(() => tickRef.current());
  }, [geom, signature]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      animRef.current = null;
    },
    [],
  );

  const paths = framePaths ?? targetPaths;
  const ghost = paths.ghost;

  return (
    // One mount-only reveal fade (data-chart-motion="morph"); UPDATE morphs are the point
    // interpolation above, not a re-mount, so this never replays on a period change.
    <g data-chart-motion="morph" data-chart-morph-state={framePaths ? 'running' : 'idle'}>
      {/* Comparison (previous period) — solid smooth area only in the `comparison` appearance; the
          legacy hosts keep a dashed reference line. Its dim rides strokeOpacity so no fade can
          brighten the dashed pattern, and we morph the point geometry, never stroke-dasharray. */}
      {ghost && comparison && ghost.area && (
        <path data-chart-series="comparison-area" d={ghost.area} fill={`url(#${comparisonGradientId})`} />
      )}
      {ghost && ghost.line && (
        <path
          data-chart-series="comparison"
          d={ghost.line}
          fill="none"
          stroke="hsl(var(--chart-role-comparison))"
          strokeWidth={comparison ? '2' : '1.8'}
          strokeDasharray={comparison ? undefined : '5 4'}
          strokeOpacity={comparison ? '0.95' : '0.8'}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}

      {/* Primary series — gradient area + smooth line. */}
      {paths.primary.area && (
        <path data-chart-series="primary-area" d={paths.primary.area} fill={`url(#${primaryGradientId})`} />
      )}
      {paths.primary.line && (
        <path
          data-chart-series="primary"
          d={paths.primary.line}
          fill="none"
          stroke="hsl(var(--chart-role-primary))"
          strokeWidth={richStyle ? '2' : '2.5'}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </g>
  );
}
