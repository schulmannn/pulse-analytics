import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { easeChartMorph, interpolatePoints, resamplePoints, type MorphPoint } from '@/lib/chartMorph';
import { prefersReducedMotion, readMorphMs } from '@/lib/chartMotionRuntime';
import { smoothSvgPath } from '@/lib/format';

/**
 * The UPDATE-morph data layer for {@link Sparkline} — the same «flow from the old shape into the new
 * shape» read the full {@link MorphingSeries}/LineChart uses, sized down for the inline micro-chart.
 * Isolated in its OWN component so the RAF loop's per-frame setState re-renders only the two series
 * paths (line + optional area), never the parent card (headline, delta, hover dots, caption all stay
 * put). On a data / period change the geometry interpolates continuously from the previously rendered
 * shape to the new one (Recharts-style proportional point matching, so 30↔7↔90↔all morph despite the
 * point-count change); a value-identical rerender or a hover keeps the current geometry; reduced
 * motion snaps. See frontend/DESIGN_TOKENS.md «Chart motion».
 *
 * The sparkline never carries `null` gaps (its inputs are finite numbers), so unlike MorphingSeries
 * this builder skips the gap-splitting — one continuous smooth cubic, byte-identical to the static
 * `sparkPath`/`sparkAreaPath` render once a morph settles.
 */

interface SparklineSeriesProps {
  /** Target geometry in viewBox coordinates (200×32, PAD=2) — same math as `sparkPath`. */
  points: MorphPoint[];
  /** Stable DATA signature (seriesMotionKey). A change = a real data/period swap → morph. */
  signature: string;
  color: string;
  strokeWidth: number;
  area: boolean;
  gradientId: string;
  /** Полюса линии (канон LineChart): начало — полая точка, конец — сплошная. Рисуются из
      ТЕКУЩЕГО КАДРА морфа, чтобы скользить вместе с линией (в HTML-оверлее родителя они прыгали
      в целевое место при смене периода — владелец). viewBox растянут (preserveAspectRatio=none),
      поэтому это не <circle> (стал бы эллипсом), а линия нулевой длины с round-cap и
      non-scaling-stroke — идеально круглая точка в экранных px при любом растяжении. */
  poles?: boolean;
}

type SparkPaths = { line: string; area: string; points: ReadonlyArray<MorphPoint> };

// Sparkline area closes to the viewBox floor and back to the left edge — identical to sparkAreaPath,
// so a settled morph frame is byte-identical to the static render.
const AREA_CLOSE = ' L200,32 L0,32 Z';

/** Line + area path strings for a gap-free sparkline point series (precision 1, matching sparkPath). */
function buildSparkPaths(points: ReadonlyArray<MorphPoint>): SparkPaths {
  const line = smoothSvgPath(
    points.map((p) => ({ x: p.x, y: (p.y ?? 0) as number })),
    1,
  );
  return { line, area: line ? `${line}${AREA_CLOSE}` : '', points };
}

/** Круглая точка в растянутом viewBox: линия нулевой длины + round-cap + non-scaling-stroke.
    `size` — диаметр в ЭКРАННЫХ px (это strokeWidth, а он non-scaling). */
function PoleDot({ p, size, stroke }: { p: MorphPoint; size: number; stroke: string }) {
  return (
    <path
      d={`M ${p.x} ${p.y} h 0.0001`}
      fill="none"
      stroke={stroke}
      strokeWidth={size}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
      focusable="false"
    />
  );
}

function samePoints(a: ReadonlyArray<MorphPoint>, b: ReadonlyArray<MorphPoint>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((point, index) => point.x === b[index].x && point.y === b[index].y);
}

export function SparklineSeries({ points, signature, color, strokeWidth, area, gradientId, poles = false }: SparklineSeriesProps) {
  // Idle / settled paths — recomputed only when the geometry object changes, never per frame. During
  // a morph we render `framePaths` instead.
  const targetPaths = useMemo<SparkPaths>(() => buildSparkPaths(points), [points]);

  const [framePaths, setFramePaths] = useState<SparkPaths | null>(null);

  // `targetRef` gives the RAF loop the live target (so a rapid re-switch mid-morph retargets);
  // `displayedRef` holds the currently RENDERED geometry so a second period change starts from the
  // visible shape, not a snapped one.
  const targetRef = useRef(points);
  targetRef.current = points;
  const prevPointsRef = useRef(points);
  const displayedRef = useRef<MorphPoint[]>(points);
  const sigRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const animRef = useRef<{ from: MorphPoint[]; start: number; dur: number } | null>(null);

  // Mirror the rendered geometry into `displayedRef` while IDLE and the signature is unchanged (a
  // value-identical rerender / hover). On a data change the layout effect below captures the OLD
  // visible shape as the morph's start, so we must NOT overwrite it here.
  if (animRef.current == null && signature === sigRef.current) {
    displayedRef.current = points;
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
    const e = easeChartMorph(t);
    const target = targetRef.current;
    const from = resamplePoints(anim.from, target.length);
    const cur = interpolatePoints(from, target, e);
    displayedRef.current = cur;
    setFramePaths(buildSparkPaths(cur));
    if (t < 1) {
      rafRef.current = requestAnimationFrame(() => tickRef.current());
    } else {
      animRef.current = null;
      rafRef.current = null;
      displayedRef.current = target;
      // Fall back to the exact target render (byte-identical to the static geometry).
      setFramePaths(null);
    }
  };

  useLayoutEffect(() => {
    const previous = prevPointsRef.current;
    prevPointsRef.current = points;
    if (sigRef.current === null) {
      // First mount: no morph (the CSS mount reveal covers entrance). Record the baseline.
      sigRef.current = signature;
      displayedRef.current = points;
      return;
    }
    if (sigRef.current === signature) {
      // Same data signature: a referentially-new-but-equal array (refetch) or a hover rerender —
      // never a reason to restart. The sparkline's geometry is fixed in the viewBox (independent of
      // container size), so an unchanged signature can only mean unchanged geometry; snap-mirror it
      // to keep displayedRef honest and leave any in-flight morph alone.
      if (!samePoints(previous, points) && animRef.current == null) {
        displayedRef.current = points;
        setFramePaths(null);
      }
      return;
    }
    sigRef.current = signature;

    if (prefersReducedMotion()) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      animRef.current = null;
      displayedRef.current = points;
      setFramePaths(null);
      return;
    }

    // Start (or restart) the morph from the currently VISIBLE geometry toward the new target.
    const from = resamplePoints(displayedRef.current, points.length);
    animRef.current = { from, start: performance.now(), dur: readMorphMs() };
    displayedRef.current = from;
    // A layout effect plus this synchronous start frame prevents a one-frame flash of the target
    // shape before the first RAF. React flushes the update before the browser paints.
    setFramePaths(buildSparkPaths(from));
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(() => tickRef.current());
  }, [points, signature]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      animRef.current = null;
    },
    [],
  );

  const paths = framePaths ?? targetPaths;
  const first = poles && paths.points.length > 0 ? paths.points[0] : null;
  const last = poles && paths.points.length > 1 ? paths.points[paths.points.length - 1] : null;

  return (
    // One mount-only reveal fade (data-chart-motion="morph"); UPDATE morphs are the point
    // interpolation above, not a re-mount, so this never replays on a period change.
    <g data-chart-motion="morph" data-chart-morph-state={framePaths ? 'running' : 'idle'}>
      {area && paths.area && <path data-chart-series="primary-area" d={paths.area} fill={`url(#${gradientId})`} />}
      {paths.line && (
        <path
          data-chart-series="primary"
          d={paths.line}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* Полюса: начало — полая (цветное кольцо поверх фоновой сердцевины), конец — сплошная
          с фоновым гало (отделяется от линии). Едут с текущим кадром морфа. */}
      {first && first.y != null && (
        <g data-chart-pole="first">
          <PoleDot p={first} size={7} stroke={color} />
          <PoleDot p={first} size={4} stroke="hsl(var(--background))" />
        </g>
      )}
      {last && last.y != null && (
        <g data-chart-pole="last">
          <PoleDot p={last} size={9} stroke="hsl(var(--background))" />
          <PoleDot p={last} size={6} stroke={color} />
        </g>
      )}
    </g>
  );
}
