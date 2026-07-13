'use strict';

/* ── Tenancy access predicates (SQL fragments) — общий db-leaf ───────────────────────────────────
   Живёт в общем db-слое (рядом с pool/errors/transaction), а НЕ внутри channelsRepo, потому что
   workspace-изоляцию делят НЕСКОЛЬКО доменов: channelsRepo (getChannel/listChannels/api-keys),
   analyticsRepo (getChannelHistory/getLatestVelocity/getCollectorStatus). Репозитории не импортят
   друг друга → общий предикат обязан быть здесь. Одна точка правды на «кто видит канал», чтобы
   новая query не забыла изоляцию.

   Finding 6 (PR 9): бывшие строки-константы с внешними `.replaceAll('$UID','$N')` /
   `.replaceAll('channels.','c.')` стали ФУНКЦИЯМИ — alias и номер параметра собираются внутри.
   Внешний строковый replace мог тихо ослабить access (промахнулся алиасом → предикат сравнивает
   не ту таблицу и молча пропускает всех). SQL-вывод байт-в-байт прежний — см. test/db_access.test.js. */

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
// `channelAlias` — алиас таблицы каналов в запросе; `uidParam` — позиционный параметр ('$2' и т.п.).
const channelAccessSql = ({ channelAlias = 'channels', uidParam }) =>
  `(${channelAlias}.owner_uid = ${uidParam}
    OR (${channelAlias}.workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM workspace_members m
          WHERE m.workspace_id = ${channelAlias}.workspace_id AND m.uid = ${uidParam})))`;

// То же, но доступ только владельцу/админу воркспейса (api-keys и прочие admin-операции).
const channelAdminAccessSql = ({ channelAlias = 'c', uidParam }) =>
  `(${channelAlias}.owner_uid = ${uidParam}
    OR (${channelAlias}.workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM workspace_members m
          WHERE m.workspace_id = ${channelAlias}.workspace_id
            AND m.uid = ${uidParam}
            AND m.role IN ('owner', 'admin'))))`;

module.exports = { sameTenantSource, channelAccessSql, channelAdminAccessSql };
