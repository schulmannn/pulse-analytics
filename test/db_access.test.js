'use strict';

// Finding 6 (PR 9 распила db.js): channelAccessSql/channelAdminAccessSql — функции вместо
// строк-констант с внешним replaceAll. Тест фиксирует БАЙТ-эквивалентность: вывод функции
// равен старой константе после тех же replaceAll (легаси-строки здесь как fixtures, скопированы
// из db/access.js до правки). Разойдётся вывод — значит access-предикат ИЗМЕНИЛСЯ, а это
// security-поверхность (tenancy).

const test = require('node:test');
const assert = require('node:assert/strict');
const { channelAccessSql, channelAdminAccessSql, sameTenantSource } = require('../server/db/access');

const LEGACY_CHANNEL_ACCESS_PREDICATE =
  `(channels.owner_uid = $UID
    OR (channels.workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM workspace_members m
          WHERE m.workspace_id = channels.workspace_id AND m.uid = $UID)))`;

const LEGACY_CHANNEL_ADMIN_ACCESS_PREDICATE =
  `(c.owner_uid = $UID
    OR (c.workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM workspace_members m
          WHERE m.workspace_id = c.workspace_id
            AND m.uid = $UID
            AND m.role IN ('owner', 'admin'))))`;

test('channelAccessSql(default alias) ≡ легаси-константа с replaceAll($UID)', () => {
  for (const p of ['$1', '$2', '$3']) {
    assert.equal(channelAccessSql({ uidParam: p }), LEGACY_CHANNEL_ACCESS_PREDICATE.replaceAll('$UID', p));
  }
});

test('channelAccessSql(alias c) ≡ легаси с replaceAll(channels.→c.) — кейс getCollectorStatus', () => {
  assert.equal(
    channelAccessSql({ channelAlias: 'c', uidParam: '$2' }),
    LEGACY_CHANNEL_ACCESS_PREDICATE.replaceAll('channels.', 'c.').replaceAll('$UID', '$2'));
});

test('channelAdminAccessSql ≡ легаси-admin с replaceAll($UID)', () => {
  for (const p of ['$2', '$3']) {
    assert.equal(channelAdminAccessSql({ uidParam: p }), LEGACY_CHANNEL_ADMIN_ACCESS_PREDICATE.replaceAll('$UID', p));
  }
});

test('sameTenantSource не менялся (smoke по алиасам)', () => {
  const sql = sameTenantSource('d', 'c');
  assert.ok(sql.includes('src.id = d.channel_id'));
  assert.ok(sql.includes('c.workspace_id IS NOT NULL AND src.workspace_id = c.workspace_id'));
});
