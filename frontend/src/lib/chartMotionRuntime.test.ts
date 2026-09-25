import { describe, expect, it } from 'vitest';
import { parseCssDurationMs } from '@/lib/chartMotionRuntime';

// The morph duration reaches the RAF loop through getComputedStyle → this parser. The PROD bug this
// pins: cssnano/LightningCSS minify `700ms` → `.7s`, and a unit-blind parseFloat turned that into
// 0.7 MILLISECONDS — every chart morph completed on its first frame in production while the dev
// server (unminified CSS) looked fine. The parser must treat both spellings identically.
describe('parseCssDurationMs (unit-aware CSS <time> → ms)', () => {
  it('parses the authored milliseconds form', () => {
    expect(parseCssDurationMs('700ms')).toBe(700);
    expect(parseCssDurationMs(' 240ms ')).toBe(240);
  });

  it('parses the minified seconds form to the SAME duration', () => {
    expect(parseCssDurationMs('.7s')).toBe(700);
    expect(parseCssDurationMs('0.7s')).toBe(700);
    expect(parseCssDurationMs('1.5s')).toBe(1500);
  });

  it('treats a bare number as milliseconds', () => {
    expect(parseCssDurationMs('700')).toBe(700);
  });

  it('returns null for empty, invalid and non-positive values (caller falls back)', () => {
    expect(parseCssDurationMs('')).toBeNull();
    expect(parseCssDurationMs('auto')).toBeNull();
    expect(parseCssDurationMs('0s')).toBeNull();
    expect(parseCssDurationMs('0ms')).toBeNull();
    expect(parseCssDurationMs('-1s')).toBeNull();
  });
});
