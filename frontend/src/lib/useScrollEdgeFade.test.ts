import { describe, expect, it } from 'vitest';
import { scrollEdgeFadeState } from '@/lib/useScrollEdgeFade';

describe('scrollEdgeFadeState', () => {
  it('removes both fades when the rail does not overflow', () => {
    expect(scrollEdgeFadeState({ scrollLeft: 0, scrollWidth: 320, clientWidth: 320 })).toEqual({
      start: false,
      end: false,
    });
  });

  it('marks the hidden edges at the start, middle and end of an overflowing rail', () => {
    expect(scrollEdgeFadeState({ scrollLeft: 0, scrollWidth: 600, clientWidth: 300 })).toEqual({
      start: false,
      end: true,
    });
    expect(scrollEdgeFadeState({ scrollLeft: 140, scrollWidth: 600, clientWidth: 300 })).toEqual({
      start: true,
      end: true,
    });
    expect(scrollEdgeFadeState({ scrollLeft: 300, scrollWidth: 600, clientWidth: 300 })).toEqual({
      start: true,
      end: false,
    });
  });
});
