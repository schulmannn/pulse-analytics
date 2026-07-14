import { describe, expect, it } from 'vitest';
import { SIZE_COL_SPAN } from '@/components/chartWidget/constants';

describe('widget desktop footprints', () => {
  it('maps the public 33/50/100 size labels to a six-column grid literally', () => {
    expect(SIZE_COL_SPAN).toEqual({
      third: 'lg:col-span-2',
      half: 'lg:col-span-3',
      full: 'lg:col-span-6',
    });
  });
});
