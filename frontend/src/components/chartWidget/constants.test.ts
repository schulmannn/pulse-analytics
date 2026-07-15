import { describe, expect, it } from 'vitest';
import { SIZE_COL_SPAN } from '@/components/chartWidget/constants';

describe('widget desktop footprints', () => {
  it('maps the internal S/M/L footprints to a six-column grid literally', () => {
    expect(SIZE_COL_SPAN).toEqual({
      third: 'lg:col-span-2',
      half: 'lg:col-span-3',
      full: 'lg:col-span-6',
    });
  });
});
