'use strict';

/* ── Tenancy access predicates (SQL fragments) — общий db-leaf ───────────────────────────────────
   Извлечено ДОСЛОВНО из db.js (SQL не менялся). Живёт в общем db-слое (рядом с pool/errors/
   transaction), а НЕ внутри channelsRepo, потому что workspace-изоляцию делят НЕСКОЛЬКО доменов:
   channelsRepo (getChannel/listChannels/api-keys) И analytics-ридеры (getChannelHistory/
   getLatestVelocity/getCollectorStatus — пока в db.js, позже analyticsRepo). Репозитории не
   импортят друг друга → общий предикат обязан быть здесь. Это тот самый reusable `channelAccessSql`
   из спеки: одна точка правды на «кто видит канал», чтобы новая query не забыла изоляцию.

   `$UID` — плейсхолдер: на месте использования подставляется `.replaceAll('$UID', '$N')` под номер
   позиционного параметра. `channels.`/`c.` — алиас читающего канала (см. каждый предикат). */

// ── Canonical source-read trust boundary (security: tenancy isolation audit, finding F1) ───────
// Phase-B canonical reads (getChannelHistory / getLatestVelocity / memberCount) union rows by a
// shared source_id so two links to ONE external property see one row-set (ADR-001). That union MUST
// stay inside the reader-channel's access boundary: a user can bind a channel to ANY external
// identity with NO proof of access — a QR link takes a raw browser-supplied tg id
// (POST /api/tg/qr/channels), a collector self-reports channel.id on ingest — so an UNRESTRICTED
// source union would hand a claimer another tenant's admin-only history (joins/leaves/reactions and
// per-post velocity, none of it public). We therefore union only rows written by a channel in the
// SAME workspace as the reader-channel (or the SAME creator — covers legacy/central rows whose
// workspace_id is still NULL). Same-workspace co-following still shares; cross-workspace sharing
// waits for an access-verified follow (roadmap P2.2). `rowAlias` = data-row table, `chanAlias` =
// the reader channel.
const sameTenantSource = (rowAlias, chanAlias) =>
  `EXISTS (SELECT 1 FROM channels src WHERE src.id = ${rowAlias}.channel_id
             AND (src.owner_uid = ${chanAlias}.owner_uid
                  OR (${chanAlias}.workspace_id IS NOT NULL AND src.workspace_id = ${chanAlias}.workspace_id)))`;

// Access boundary (ADR-001): a channel is visible to its creator (legacy owner_uid — also covers
// pre-workspace rows like the bootstrap central channel) OR to any member of its workspace.
const CHANNEL_ACCESS_PREDICATE =
  `(channels.owner_uid = $UID
    OR (channels.workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM workspace_members m
          WHERE m.workspace_id = channels.workspace_id AND m.uid = $UID)))`;

const CHANNEL_ADMIN_ACCESS_PREDICATE =
  `(c.owner_uid = $UID
    OR (c.workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM workspace_members m
          WHERE m.workspace_id = c.workspace_id
            AND m.uid = $UID
            AND m.role IN ('owner', 'admin'))))`;

module.exports = { sameTenantSource, CHANNEL_ACCESS_PREDICATE, CHANNEL_ADMIN_ACCESS_PREDICATE };
