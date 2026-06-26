import { describe, expect, it } from 'vitest';
import { pickActiveSection } from '@/lib/scrollspy';

describe('pickActiveSection', () => {
  it('chooses the section with the greatest visible share', () => {
    expect(
      pickActiveSection([
        { id: 'metrics', top: -80, ratio: 0.25 },
        { id: 'growth', top: 140, ratio: 0.8 },
        { id: 'posts', top: 600, ratio: 0.1 },
      ]),
    ).toBe('growth');
  });

  it('uses distance to the viewport top and then input order as stable tie-breakers', () => {
    expect(
      pickActiveSection([
        { id: 'first', top: -120, ratio: 0.5 },
        { id: 'second', top: 40, ratio: 0.5 },
      ]),
    ).toBe('second');

    expect(
      pickActiveSection([
        { id: 'first', top: -40, ratio: 0.5 },
        { id: 'second', top: 40, ratio: 0.5 },
      ]),
    ).toBe('first');
  });

  it('handles empty, hidden and single-section inputs', () => {
    expect(pickActiveSection([])).toBeNull();
    expect(pickActiveSection([{ id: 'hidden', top: 0, ratio: 0 }])).toBeNull();
    expect(pickActiveSection([{ id: 'only', top: 20, ratio: 0.2 }])).toBe('only');
  });
});
