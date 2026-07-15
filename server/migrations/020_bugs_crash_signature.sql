-- 020_bugs_crash_signature.sql — one visible crash ticket per unique signature.
-- Client crashes (kind='crash') used to insert one `bugs` row per occurrence and separately bump the
-- `crash_signatures` ledger in a second fire-and-forget write. This links the two: a nullable
-- `crash_signature` on the ticket + a PARTIAL UNIQUE index lets the recorder upsert exactly one
-- aggregated ticket per signature atomically with the ledger.
--
-- Additive + idempotent. Historical crash rows keep crash_signature = NULL and are deliberately
-- EXCLUDED from the index (the `crash_signature IS NOT NULL` predicate) — they are never destructively
-- deduplicated or backfilled, so the migration is safe on existing data.
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS crash_signature TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS bugs_crash_signature_uidx
  ON bugs (crash_signature)
  WHERE kind = 'crash' AND crash_signature IS NOT NULL;
