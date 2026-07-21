import { describe, expect, it } from 'vitest';
import {
  buildSeriesPaths,
  easeStandard,
  interpolatePoints,
  resamplePoints,
  type MorphPoint,
} from '@/lib/chartMorph';

// The LineChart UPDATE morph flows the old shape into the new one by interpolating POINT geometry.
// These helpers are the pure core the RAF loop calls every frame, so their invariants — proportional
// matching across lengths, exact endpoints, honest null gaps, and NO mutation — are the morph's
// correctness contract.

const p = (x: number, y: number | null): MorphPoint => ({ x, y });
const clone = (pts: MorphPoint[]) => pts.map((q) => ({ ...q }));

describe('resamplePoints (proportional length matching — Recharts matchByIndex)', () => {
  it('returns the SAME geometry when the target length equals the source length', () => {
    const src = [p(0, 0), p(10, 5), p(20, 2)];
    expect(resamplePoints(src, 3)).toEqual(src);
  });

  it('keeps the first and last vertices exact when up- or down-sampling', () => {
    const src = [p(0, 0), p(10, 10), p(20, 0)];
    const up = resamplePoints(src, 5);
    expect(up).toHaveLength(5);
    expect(up[0]).toEqual(p(0, 0));
    expect(up[4]).toEqual(p(20, 0));
    // Midpoint slot (j=2 → pos 1.0) lands exactly on the source apex.
    expect(up[2]).toEqual(p(10, 10));

    const down = resamplePoints(src, 2);
    expect(down).toEqual([p(0, 0), p(20, 0)]);
  });

  it('interpolates intermediate slots linearly between bracketing source points', () => {
    const src = [p(0, 0), p(10, 10)];
    // length 3 → slots at pos 0, 0.5, 1.0 → the middle is the average of the two vertices.
    expect(resamplePoints(src, 3)).toEqual([p(0, 0), p(5, 5), p(10, 10)]);
  });

  it('a single-point source fills every slot with that point (no NaN spread)', () => {
    expect(resamplePoints([p(4, 7)], 3)).toEqual([p(4, 7), p(4, 7), p(4, 7)]);
  });

  it('never bridges a gap: a slot whose bracket touches a null is itself a gap', () => {
    // Source: real, gap, real. Upsampling must not invent a value inside the hole.
    const src = [p(0, 0), p(10, null), p(20, 20)];
    const out = resamplePoints(src, 5);
    // Endpoints stay real; any slot bracketed by the null carries y === null.
    expect(out[0]).toEqual(p(0, 0));
    expect(out[4]).toEqual(p(20, 20));
    expect(out.some((q) => q.y === null)).toBe(true);
    // The exact-hit middle slot (pos 2.0) copies the source gap verbatim.
    expect(out[2]).toEqual(p(10, null));
  });

  it('does not mutate its input', () => {
    const src = [p(0, 0), p(10, 10), p(20, 5)];
    const snapshot = clone(src);
    resamplePoints(src, 7);
    expect(src).toEqual(snapshot);
  });

  it('degenerate lengths are safe', () => {
    expect(resamplePoints([p(0, 0), p(1, 1)], 0)).toEqual([]);
    expect(resamplePoints([], 3)).toEqual([p(0, null), p(0, null), p(0, null)]);
  });
});

describe('interpolatePoints (per-frame morph blend)', () => {
  const from = [p(0, 0), p(10, 10), p(20, 0)];
  const to = [p(0, 4), p(10, 0), p(20, 8)];

  it('t=0 returns the FROM geometry exactly', () => {
    expect(interpolatePoints(from, to, 0)).toEqual(from);
  });

  it('t=1 returns the TO geometry exactly', () => {
    expect(interpolatePoints(from, to, 1)).toEqual(to);
  });

  it('t=0.5 is the midpoint of each coordinate', () => {
    expect(interpolatePoints(from, to, 0.5)).toEqual([p(0, 2), p(10, 5), p(20, 4)]);
  });

  it('a gap on EITHER endpoint pins the point to its TARGET (no slide across a hole)', () => {
    const gapFrom = [p(0, 0), p(10, null), p(20, 0)];
    const solidTo = [p(0, 10), p(10, 10), p(20, 10)];
    // Middle point: from is a gap → it must appear at the target position at every t, not interpolate.
    expect(interpolatePoints(gapFrom, solidTo, 0.5)[1]).toEqual(p(10, 10));

    const solidFrom = [p(0, 0), p(10, 0), p(20, 0)];
    const gapTo = [p(0, 5), p(10, null), p(20, 5)];
    // Target is a gap → the point is a gap for the whole morph (honest absence).
    expect(interpolatePoints(solidFrom, gapTo, 0.5)[1]).toEqual(p(10, null));
  });

  it('throws on mismatched lengths (callers must resample first)', () => {
    expect(() => interpolatePoints([p(0, 0)], [p(0, 0), p(1, 1)], 0.5)).toThrow();
  });

  it('does not mutate either input', () => {
    const a = clone(from);
    const b = clone(to);
    interpolatePoints(from, to, 0.5);
    expect(from).toEqual(a);
    expect(to).toEqual(b);
  });
});

describe('resample + interpolate compose to a shape morph across lengths', () => {
  it('t=0 is the (resampled) old shape and t=1 is the new shape', () => {
    const oldShape = [p(0, 0), p(30, 30), p(60, 0), p(90, 30)]; // 4 points (e.g. 90d)
    const newShape = [p(0, 10), p(45, 5)]; // 2 points (e.g. 7d)
    const fromResampled = resamplePoints(oldShape, newShape.length);
    expect(interpolatePoints(fromResampled, newShape, 0)).toEqual(fromResampled);
    expect(interpolatePoints(fromResampled, newShape, 1)).toEqual(newShape);
  });
});

describe('buildSeriesPaths (segments + smooth cubic, honest gaps)', () => {
  it('a contiguous series is one smooth sub-path, area closed to baseY', () => {
    const { line, area } = buildSeriesPaths([p(0, 0), p(10, 10), p(20, 5)], 32);
    expect(line.startsWith('M')).toBe(true);
    expect(line).toContain('C'); // smooth cubic, not straight L segments
    // Exactly one moveTo — a single continuous run.
    expect(line.match(/M/g)?.length).toBe(1);
    expect(area.endsWith('Z')).toBe(true);
    expect(area).toContain(' 32'); // closed down to baseY
  });

  it('a null gap splits the line into two sub-paths (no bridge across the hole)', () => {
    const { line, area } = buildSeriesPaths([p(0, 0), p(10, 5), p(20, null), p(30, 5), p(40, 0)], 32);
    expect(line.match(/M/g)?.length).toBe(2); // two runs
    expect(area.match(/Z/g)?.length).toBe(2); // each run closed independently
  });

  it('a lone real point between gaps contributes nothing (a zero-length line is invisible)', () => {
    const { line, area } = buildSeriesPaths([p(0, null), p(10, 5), p(20, null)], 32);
    expect(line).toBe('');
    expect(area).toBe('');
  });

  it('an all-gap series yields empty paths', () => {
    expect(buildSeriesPaths([p(0, null), p(10, null)], 32)).toEqual({ line: '', area: '' });
  });
});

describe('easeStandard (house --ease-standard mirrored in JS)', () => {
  it('is pinned at the endpoints', () => {
    expect(easeStandard(0)).toBe(0);
    expect(easeStandard(1)).toBe(1);
    expect(easeStandard(-0.5)).toBe(0);
    expect(easeStandard(2)).toBe(1);
  });

  it('is monotonically increasing across the unit interval', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const y = easeStandard(i / 20);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it('front-loads progress (ease-out): halfway in time is already past halfway in value', () => {
    expect(easeStandard(0.5)).toBeGreaterThan(0.5);
    expect(easeStandard(0.5)).toBeLessThan(1);
  });
});
