// Pure safety helpers for ops/db-restore.mjs. Kept side-effect-free (no pg, no argv, no top-level
// await) so they can be unit-tested without touching a database or running a destructive restore.

// A snapshot restore truncates every snapshotted table in one statement. An older implementation
// added CASCADE, which also silently truncated any public child table absent from the snapshot.
// The restore now omits CASCADE (so Postgres itself fails closed) and this helper detects the common
// public-schema mismatch early enough to return an actionable operator error.
//
//   fkRows        — [{ child, parent }] child→parent FK edges in schema 'public'
//   truncateSet   — iterable of table names that WILL be truncated (snapshot tables, minus
//                   schema_migrations — mirror the exact set passed to TRUNCATE)
// Returns a sorted, de-duplicated list of external child tables that block a safe restore.
function externalReferencers(fkRows, truncateSet) {
  const truncated = truncateSet instanceof Set ? truncateSet : new Set(truncateSet);
  const external = new Set();
  for (const { child, parent } of fkRows) {
    // If parent is truncated but child is not (and it's a real cross-table edge), the snapshot is
    // incomplete for this target schema.
    if (child !== parent && truncated.has(parent) && !truncated.has(child)) external.add(child);
  }
  return [...external].sort();
}

export { externalReferencers };
