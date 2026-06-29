import { describe, expect, it } from 'vitest';
import { toCsv } from '@/lib/csv';

describe('toCsv', () => {
  it('returns empty string for no rows', () => {
    expect(toCsv([])).toBe('');
  });

  it('writes a header row from the first object keys + CRLF rows', () => {
    const csv = toCsv([
      { day: '2026-06-01', reach: 100 },
      { day: '2026-06-02', reach: 250 },
    ]);
    expect(csv).toBe('day,reach\r\n2026-06-01,100\r\n2026-06-02,250');
  });

  it('quotes cells with commas, quotes or newlines and escapes inner quotes', () => {
    const csv = toCsv([{ caption: 'hello, "world"\nnext', n: 1 }]);
    expect(csv).toBe('caption,n\r\n"hello, ""world""\nnext",1');
  });

  it('renders null/undefined as empty cells', () => {
    expect(toCsv([{ a: null, b: undefined, c: 0 }])).toBe('a,b,c\r\n,,0');
  });

  it('uses the union of all row keys (sparse rows keep every column)', () => {
    const csv = toCsv([
      { day: '2026-06-01', reach: 100 },
      { day: '2026-06-02', reach: 120, saves: 9 }, // `saves` absent from row 0
    ]);
    expect(csv).toBe('day,reach,saves\r\n2026-06-01,100,\r\n2026-06-02,120,9');
  });
});
