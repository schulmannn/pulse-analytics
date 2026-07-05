// Snapshot identity preservation for the useSyncExternalStore-backed localStorage stores
// (widgetStore's WidgetConfig[], ChartWidget's prefs/order maps). A snapshot is re-parsed whenever
// the stored raw string changes, which would hand EVERY entry a fresh object identity — so a
// per-widget selector (or a memo'd card) could never bail out: one widget's write would still
// re-render all of them. These helpers rebuild the freshly-parsed snapshot reusing the PREVIOUS
// object for every entry that is structurally unchanged, making reference identity track actual
// data changes — the precondition for O(1) re-renders on a point mutation.
//
// JSON.stringify equality is sound here because both sides come from the same producer with a
// deterministic key order: either JSON.parse of a blob this code serialised, or a normalizer that
// builds objects with literal keys (normalizeWidget). A key-order mismatch would only cost a missed
// reuse (one extra re-render) — never a stale bailout.

const jsonEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Rebuild `next` reusing `prev`'s item for every id whose entry is JSON-equal. The returned array
 *  is always `next`'s membership/order — only element identities are recycled. */
export function preserveItemIdentity<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (prev.length === 0) return next;
  const prevById = new Map(prev.map((item) => [item.id, item]));
  return next.map((item) => {
    const old = prevById.get(item.id);
    return old && jsonEq(old, item) ? old : item;
  });
}

/** Rebuild `next` reusing `prev`'s value for every key whose entry is JSON-equal. Built on a
 *  null-prototype object: JSON.parse hands a stored "__proto__" key over as an OWN property, and
 *  assigning it onto a plain literal would invoke the inherited setter and silently swap the
 *  cache's prototype (prototype pollution — the row would vanish from every serialize and leak
 *  into unrelated lookups). On a null-proto object it stays an inert own data property, exactly
 *  like the pre-cache JSON.parse behaviour; spread/Object.keys/JSON.stringify are unaffected. */
export function preserveEntryIdentity<T>(
  prev: Record<string, T>,
  next: Record<string, T>,
): Record<string, T> {
  const out: Record<string, T> = Object.create(null) as Record<string, T>;
  for (const key of Object.keys(next)) {
    const old = prev[key];
    out[key] = old !== undefined && jsonEq(old, next[key]) ? old : next[key];
  }
  return out;
}

/** Reuse `prev` itself when `next` is JSON-equal (single-value stores, e.g. the Home pin list). */
export function preserveValueIdentity<T>(prev: T, next: T): T {
  return jsonEq(prev, next) ? prev : next;
}
