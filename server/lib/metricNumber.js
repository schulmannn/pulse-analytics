'use strict';

/* ── Metric-counter numeric helper (BIGINT release, migration 023) ────────────────────────────────
   Metric counters (channel_daily / posts / mentions / ig_daily / ig_media_daily) are stored as
   PostgreSQL BIGINT, but the product's honest bound is MAX_SAFE_METRIC = 9e15. That bound is BELOW
   Number.MAX_SAFE_INTEGER (9_007_199_254_740_991), so every accepted counter round-trips through a
   JS number with NO precision loss. Nothing here is for identifiers: channel_id/source_id stay
   INTEGER, and Telegram/Instagram entity ids (BIGINT) must remain decimal STRINGS end-to-end — never
   push those through these helpers.

   Two intents, one bound:
     • toMetricInt(v)   — WRITE side. Round to an integer and reject anything outside the exact safe
       range as honest missing data (null). Replaces the old INT4 saturating clamp: a value we cannot
       store exactly becomes null (or, in the collector contract layer, a ContractError), never a
       silently invented saturated number.
     • toMetricNumber(v)— READ side. node-postgres returns BIGINT as a decimal string; convert a
       metric column back to a JS number, preserving null. A value beyond the safe bound (writers
       already reject those, so this is defensive) becomes null rather than a lossy number. */

const MAX_SAFE_METRIC = 9_000_000_000_000_000;

// Guard: MAX_SAFE_METRIC must stay within JS exact-integer range, or the "no precision loss" promise
// silently breaks. Cheap module-load assertion — never trips in practice, loud if someone bumps it.
if (MAX_SAFE_METRIC > Number.MAX_SAFE_INTEGER) {
  throw new Error('MAX_SAFE_METRIC exceeds Number.MAX_SAFE_INTEGER — metric numbers would lose precision');
}

function toMetricInt(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return Math.abs(rounded) > MAX_SAFE_METRIC ? null : rounded;
}

function toMetricNumber(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_SAFE_METRIC) return null;
  return n;
}

module.exports = { MAX_SAFE_METRIC, toMetricInt, toMetricNumber };
