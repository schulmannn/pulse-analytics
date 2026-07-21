import { describe, expect, it } from 'vitest';
import { seriesMotionKey } from '@/lib/chartMotion';

// The data-change chart motion (line/area clip `sweep`, sparkline `reveal`, bar `grow`) replays only
// when the React key changes. seriesMotionKey OWNS that key, so its invariants ARE the motion's
// replay contract: it must change on real content changes and stay byte-identical for everything
// that must NOT restart the animation (hover, tooltip, width-only resize, a value-identical refetch).
describe('seriesMotionKey (chart data-change replay contract)', () => {
  it('a value-identical rerender yields the SAME key (no replay on identity churn)', () => {
    // A refetch producing an equal-but-referentially-new array is the classic false replay.
    const a = seriesMotionKey([1, 2, 3], [4, 5, 6]);
    const b = seriesMotionKey([...[1, 2, 3]], [...[4, 5, 6]]);
    expect(a).toBe(b);
  });

  it('is derived from DATA ONLY — width / hover / tooltip are not arguments', () => {
    // The function has no width/hover parameter to vary, so a resize or a hover mousemove (which
    // never touch the series) cannot change the key. Same series in, same key out, every time.
    expect(seriesMotionKey([10, 20, 30])).toBe(seriesMotionKey([10, 20, 30]));
  });

  it('changes when a primary value changes (period / filter swap replays)', () => {
    expect(seriesMotionKey([1, 2, 3])).not.toBe(seriesMotionKey([1, 2, 4]));
  });

  it('changes when the comparison series is toggled or edited', () => {
    const withGhost = seriesMotionKey([1, 2, 3], [9, 9, 9]);
    expect(withGhost).not.toBe(seriesMotionKey([1, 2, 3]));
    expect(withGhost).not.toBe(seriesMotionKey([1, 2, 3], [9, 9, 8]));
  });

  it('distinguishes a null gap from a zero day (a hole is real absence)', () => {
    // null serializes to an empty field, 0 to "0" — a collector-skipped day must not read as the
    // same series as a genuine zero, or the sweep would fail to replay when a hole appears / fills.
    expect(seriesMotionKey([1, null, 3])).not.toBe(seriesMotionKey([1, 0, 3]));
  });

  it('folds length into the signature (a shorter / longer window replays)', () => {
    expect(seriesMotionKey([1, 2])).not.toBe(seriesMotionKey([1, 2, 2]));
  });

  it('is null/undefined-safe and collapses to a stable empty key', () => {
    expect(seriesMotionKey(null)).toBe(seriesMotionKey(undefined));
    expect(seriesMotionKey(null)).toBe('0||');
  });
});
