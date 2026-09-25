import { describe, expect, it } from 'vitest';
import {
  msChannelFilterKey,
  normalizeMsChannelFilter,
  sameMsChannelFilter,
} from '@/lib/msChannelFilter';

const A = '16f07379-8039-11ec-0a80-03970021e97d';
const B = '26f07379-8039-11ec-0a80-03970021e97e';

describe('saved MoySklad channel filter', () => {
  it('is scoped to the selected source', () => {
    expect(msChannelFilterKey(42)).toBe('ms-channels:42');
    expect(msChannelFilterKey(null)).toBe('ms-channels:none');
  });

  it('uses the same bounded canonical ids as metric URLs', () => {
    expect(normalizeMsChannelFilter([A, A.toUpperCase(), 'invalid', B])).toEqual([A, B]);
  });

  it('compares the canonical ordered selection', () => {
    expect(sameMsChannelFilter([A, B], [A, B])).toBe(true);
    expect(sameMsChannelFilter([A, B], [B, A])).toBe(false);
  });
});
