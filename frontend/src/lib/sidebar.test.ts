import { describe, expect, it } from 'vitest';
import { railMode } from './sidebar';

describe('railMode', () => {
  it('forces the icon-rail below the lg breakpoint, regardless of the manual flag', () => {
    expect(railMode(false, false)).toBe(true);
    expect(railMode(false, true)).toBe(true);
  });

  it('honors the manual collapse flag at lg and above', () => {
    expect(railMode(true, false)).toBe(false);
    expect(railMode(true, true)).toBe(true);
  });
});
