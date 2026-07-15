-- 019_report_delivery_attempts.sql
-- Durable at-most-once reservation for scheduled report email delivery. Resend's
-- Idempotency-Key header (POST /emails) guards duplicates for only 24h — a NEXT daily
-- cron tick can fall outside that window, so the provider header alone is not a durable
-- guarantee. These fields give the job its own reservation that survives process/DB
-- failure beyond Resend's retention: the job reserves the exact schedule period right
-- before calling the provider and only clears it on a known-not-sent rejection.
--
-- last_delivery_period    — schedule period key last RESERVED for a provider send
--                           (weekly ISO-week `YYYY-Www`, monthly `YYYY-MM`). NULL = free.
-- last_delivery_attempt_at— when that reservation was taken (diagnostics only; the gate
--                           is the exact-period match, never a timestamp window).
--
-- Nullable, forward-only, idempotent (ADD COLUMN IF NOT EXISTS). No UI/API shape change:
-- these are actor-internal bookkeeping columns, never returned to routes.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS last_delivery_period    TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS last_delivery_attempt_at TIMESTAMPTZ;
