import { describe, expect, it } from 'vitest';
import { preserveEntryIdentity, preserveItemIdentity, preserveValueIdentity } from '@/lib/storeIdentity';

describe('preserveItemIdentity', () => {
  const a = { id: 'a', v: 1 };
  const b = { id: 'b', v: 2 };

  it('reuses the previous object for JSON-equal items', () => {
    const next = preserveItemIdentity([a, b], [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]);
    expect(next[0]).toBe(a);
    expect(next[1]).toBe(b);
  });

  it('keeps next membership/order, recycling only unchanged elements', () => {
    const next = preserveItemIdentity([a, b], [{ id: 'b', v: 2 }, { id: 'a', v: 9 }]);
    expect(next.map((x) => x.id)).toEqual(['b', 'a']);
    expect(next[0]).toBe(b); // unchanged → recycled
    expect(next[1]).not.toBe(a); // mutated → fresh identity
    expect(next[1]).toEqual({ id: 'a', v: 9 });
  });

  it('a one-item write leaves every other item identity intact', () => {
    const prev = [a, b, { id: 'c', v: 3 }];
    const next = preserveItemIdentity(prev, [
      { id: 'a', v: 1 },
      { id: 'b', v: 42 },
      { id: 'c', v: 3 },
    ]);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).not.toBe(prev[1]);
    expect(next[2]).toBe(prev[2]);
  });

  it('handles empty prev/next', () => {
    const fresh = [{ id: 'x', v: 0 }];
    expect(preserveItemIdentity([], fresh)).toBe(fresh);
    expect(preserveItemIdentity([a], [])).toEqual([]);
  });
});

describe('preserveEntryIdentity', () => {
  it('reuses unchanged entries and replaces mutated ones', () => {
    const w1 = { color: 2 };
    const w2 = { hidden: true };
    const prev: Record<string, Record<string, unknown>> = { w1, w2 };
    const out = preserveEntryIdentity(prev, { w1: { color: 2 }, w2: { hidden: true, title: 'x' } });
    expect(out.w1).toBe(w1);
    expect(out.w2).not.toBe(w2);
    expect(out.w2).toEqual({ hidden: true, title: 'x' });
  });

  it('drops keys absent from next (deleted prefs rows)', () => {
    const out = preserveEntryIdentity({ gone: { a: 1 } }, {});
    expect(Object.keys(out)).toEqual([]);
  });

  it('preserves array entries (group order lists)', () => {
    const home = ['digest', 'history'];
    const out = preserveEntryIdentity({ home }, { home: ['digest', 'history'], other: ['x'] });
    expect(out.home).toBe(home);
    expect(out.other).toEqual(['x']);
  });

  it('a stored "__proto__" key stays an inert own property (no prototype pollution)', () => {
    // JSON.parse hands "__proto__" over as an OWN key — rebuilding the map must not turn it into a
    // prototype swap (a hostile /api/prefs blob hydrated into localStorage reaches this path).
    const next = JSON.parse('{"__proto__":{"title":"HACKED"},"w1":{"color":1}}') as Record<
      string,
      Record<string, unknown>
    >;
    const out = preserveEntryIdentity({}, next);
    expect(Object.getPrototypeOf(out)).toBe(null); // null-proto container — setter can't fire
    expect(out.w1).toEqual({ color: 1 });
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true); // inert own row
    expect(({} as { title?: unknown }).title).toBeUndefined(); // global prototype untouched
  });
});

describe('preserveValueIdentity', () => {
  it('keeps the previous reference when JSON-equal, else adopts next', () => {
    const keys = ['a', 'b'];
    expect(preserveValueIdentity(keys, ['a', 'b'])).toBe(keys);
    const changed = preserveValueIdentity(keys, ['a']);
    expect(changed).toEqual(['a']);
    expect(changed).not.toBe(keys);
  });
});
