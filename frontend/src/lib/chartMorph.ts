// Pure geometry helpers for the LineChart UPDATE **morph** — the Recharts-style «flow from the old
// shape into the new shape» read when the period / filter changes (see frontend/DESIGN_TOKENS.md
// «Chart morph»). All functions here are side-effect-free and never mutate their inputs, so the RAF
// loop in components/MorphingSeries.tsx can call them every frame and the unit tests can pin the
// endpoints/midpoint exactly.
//
// The morph interpolates POINT GEOMETRY (x AND y), not path strings: at t=0 the drawn curve is the
// previous rendered shape, at t=1 it is the target shape. Different point counts are matched
// PROPORTIONALLY (Recharts `matchByIndex`), so a 90→30→7 (or reverse) period swap resamples the
// shorter side onto the target length instead of snapping / cross-fading.
//
// Null gaps stay HONEST. `null` y = «сбор пропущен» — a real absence, never a value. We never
// interpolate ACROSS a gap (that would fabricate a bridge over missing data): a resampled slot whose
// source bracket touches a gap is itself a gap, and an interpolated point whose from/to endpoint is a
// gap takes its TARGET position at every t (it appears at its destination rather than sliding out of /
// into a hole). This is the documented safe fallback for the only case point-matching can't be made
// continuous — scoped to the affected points, so the rest of the shape still morphs.

import { smoothSvgPath } from '@/lib/format';

/** A rendered chart point. `y === null` marks a gap day (no measurement) — drawn as a break. */
export interface MorphPoint {
  x: number;
  y: number | null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Resample `source` geometry to exactly `length` points by proportional index mapping (Recharts
 * `matchByIndex`): target slot `j` maps to source position `j/(length-1)·(m-1)`, linearly
 * interpolating between the two bracketing source points. A slot whose bracket touches a gap (`null`
 * y) is emitted as a gap — we never interpolate across missing data. Returns fresh points; `source`
 * is untouched.
 */
export function resamplePoints(source: ReadonlyArray<MorphPoint>, length: number): MorphPoint[] {
  if (length <= 0) return [];
  const m = source.length;
  if (m === 0) return Array.from({ length }, () => ({ x: 0, y: null }));
  if (m === 1) return Array.from({ length }, () => ({ x: source[0].x, y: source[0].y }));

  const out: MorphPoint[] = [];
  for (let j = 0; j < length; j++) {
    const pos = length === 1 ? 0 : (j / (length - 1)) * (m - 1);
    const i = Math.floor(pos);
    const f = pos - i;
    const a = source[i];
    // Exact hit on a source vertex (last slot, or f≈0) → copy it verbatim, gap-preserving.
    if (i >= m - 1 || f === 0) {
      out.push({ x: a.x, y: a.y });
      continue;
    }
    const b = source[i + 1];
    if (a.y == null || b.y == null) {
      // Either side of the bracket is a gap: keep an honest break, do NOT bridge it.
      out.push({ x: lerp(a.x, b.x, f), y: null });
      continue;
    }
    out.push({ x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) });
  }
  return out;
}

/**
 * Interpolate two equal-length matched point arrays at progress `t ∈ [0,1]`. Per index: if EITHER
 * endpoint is a gap, the point takes its TARGET position at every `t` (honest — it appears at its
 * destination instead of sliding across a hole); otherwise x and y lerp from→to. Returns fresh
 * points; neither input is mutated. Mismatched lengths throw — callers must resample first.
 */
export function interpolatePoints(
  from: ReadonlyArray<MorphPoint>,
  to: ReadonlyArray<MorphPoint>,
  t: number,
): MorphPoint[] {
  if (from.length !== to.length) {
    throw new Error(`interpolatePoints: length mismatch (${from.length} vs ${to.length}) — resample first`);
  }
  const out: MorphPoint[] = [];
  for (let i = 0; i < to.length; i++) {
    const a = from[i];
    const b = to[i];
    if (a.y == null || b.y == null) {
      out.push({ x: b.x, y: b.y });
      continue;
    }
    out.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
  }
  return out;
}

/**
 * Line + area SVG path strings for a point series with honest `null` gaps: the series is split into
 * continuous runs of real points (a gap ends a run), each drawn as one smooth cubic sub-path; the
 * area closes each run to `baseY`. A run of a single point contributes nothing (a zero-length line is
 * invisible; the caller draws a dot). This is the SAME builder the static render uses, so a settled
 * morph frame is byte-identical to the target geometry.
 */
export function buildSeriesPaths(
  points: ReadonlyArray<MorphPoint>,
  baseY: number,
): { line: string; area: string } {
  const segs: Array<Array<{ x: number; y: number }>> = [];
  let run: Array<{ x: number; y: number }> = [];
  for (const p of points) {
    if (p.y == null) {
      if (run.length > 0) {
        segs.push(run);
        run = [];
      }
    } else {
      run.push({ x: p.x, y: p.y });
    }
  }
  if (run.length > 0) segs.push(run);
  const lineSegs = segs.filter((s) => s.length >= 2);
  const line = lineSegs.map((segment) => smoothSvgPath(segment)).join(' ');
  const area = lineSegs
    .map((segment) => `${smoothSvgPath(segment)} L ${segment[segment.length - 1].x} ${baseY} L ${segment[0].x} ${baseY} Z`)
    .join(' ');
  return { line, area };
}

// Recharts' default `ease` evaluated in JS: the RAF loop can't consume a CSS timing function, so we
// mirror its cubic-bezier(0.25, 0.1, 0.25, 1) control points here. Keep these constants in sync with
// `--ease-chart-morph` in src/index.css. This is deliberately gentler than the house settle ease,
// whose strongly front-loaded progress made a 700ms chart morph look almost instantaneous.
const EASE_C1X = 0.25;
const EASE_C2X = 0.25;
const EASE_C1Y = 0.1;
const EASE_C2Y = 1;

function bezier(c1: number, c2: number, u: number): number {
  const v = 1 - u;
  return 3 * v * v * u * c1 + 3 * v * u * u * c2 + u * u * u;
}
function bezierSlope(c1: number, c2: number, u: number): number {
  const v = 1 - u;
  return 3 * v * v * c1 + 6 * v * u * (c2 - c1) + 3 * u * u * (1 - c2);
}

/** Recharts-parity progress through `--ease-chart-morph`. Clamped and monotone. */
export function easeChartMorph(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Newton-solve bezierX(u) = x, then evaluate bezierY(u).
  let u = x;
  for (let i = 0; i < 8; i++) {
    const dx = bezier(EASE_C1X, EASE_C2X, u) - x;
    if (Math.abs(dx) < 1e-6) break;
    const d = bezierSlope(EASE_C1X, EASE_C2X, u);
    if (Math.abs(d) < 1e-6) break;
    u -= dx / d;
  }
  u = Math.min(1, Math.max(0, u));
  return bezier(EASE_C1Y, EASE_C2Y, u);
}
