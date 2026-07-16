'use strict';

// Db-less unit guard for channelsRepo.getChannelOrDefault — the single-query resolver on the
// auth/tenant hot path (resolveChannel). It must:
//   - default (falsy id): issue ONE lightweight query using the same index-friendly visibility
//     UNION + disabled hiding + `created_at ASC` + LIMIT 1 as getDefaultChannelId/listChannels, with
//     the member_role CASE, and NONE of listChannels' per-row analytics (memberCount/channel_daily/
//     ig_accounts) or the sensitive access_hash;
//   - explicit id (truthy): behave exactly like getChannel — ONE query, same [id, uid] bindings and
//     access predicate;
//   - never touch the pool with a missing uid or a disabled DB.
// Real tenancy semantics (owner/member/viewer/outsider, disabled, legacy, listChannels parity) live
// in the PG integration suite (tenancy.integration.test.js).

const test = require('node:test');
const assert = require('node:assert');
const { createChannelsRepo } = require('../server/repos/channelsRepo');

function fakePool(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) { calls.push({ sql, params }); return { rows }; },
  };
}

test('getChannelOrDefault default path: one query, index-friendly visibility, no analytics, row untouched', async () => {
  const row = { id: 42, username: 'chan', title: 'Chan', status: 'active', source: 'qr', tg_channel_id: '5', owner_uid: 7, member_role: 'owner' };
  const pool = fakePool([row]);
  const repo = createChannelsRepo({ pool, enabled: true, transaction: async () => {}, ensureExternalSource: async () => null });

  const out = await repo.getChannelOrDefault(0, { uid: 7 });
  assert.strictEqual(out, row, 'returns the pg row object verbatim (no re-mapping)');
  assert.strictEqual(pool.calls.length, 1, 'exactly one query — no getDefaultChannelId + getChannel fan-out');

  const { sql, params } = pool.calls[0];
  assert.deepStrictEqual(params, [7], 'single uid param on the default path');
  // Same visibility + hiding + ordering contract as getDefaultChannelId/listChannels.
  assert.match(sql, /UNION/i, 'owner ∪ workspace-member visibility set');
  assert.match(sql, /workspace_members/i, 'workspace membership branch present');
  assert.match(sql, /status<>'disabled'/i, 'disabled channels hidden');
  assert.match(sql, /ORDER BY created_at ASC/i, 'same default order as listChannels');
  assert.match(sql, /LIMIT 1/i, 'stops at the first accessible channel');
  assert.match(sql, /member_role/i, 'attaches the effective member_role');
  // …but none of listChannels' per-row extras or the sensitive access_hash.
  assert.doesNotMatch(sql, /memberCount/i, 'no memberCount projection');
  assert.doesNotMatch(sql, /channel_daily/i, 'no correlated analytics subquery');
  assert.doesNotMatch(sql, /ig_accounts/i, 'no ig_connected EXISTS');
  assert.doesNotMatch(sql, /subscribers/i, 'no analytics columns');
  assert.doesNotMatch(sql, /access_hash/i, 'no sensitive access_hash');
});

test('getChannelOrDefault default path: returns null when no accessible channel', async () => {
  const pool = fakePool([]);
  const repo = createChannelsRepo({ pool, enabled: true, transaction: async () => {}, ensureExternalSource: async () => null });
  assert.strictEqual(await repo.getChannelOrDefault(0, { uid: 7 }), null, 'empty result → null (middleware → 200 empty)');
  assert.strictEqual(pool.calls.length, 1, 'still one query');
});

test('getChannelOrDefault explicit path: one query with getChannel bindings and access predicate', async () => {
  const row = { id: 10, username: 'x', title: 'X', status: 'active', source: 'qr', tg_channel_id: null, owner_uid: 7, member_role: 'viewer' };
  const pool = fakePool([row]);
  const repo = createChannelsRepo({ pool, enabled: true, transaction: async () => {}, ensureExternalSource: async () => null });

  // Compare byte-for-byte against getChannel so any drift from delegation fails loudly.
  const ref = fakePool([row]);
  const refRepo = createChannelsRepo({ pool: ref, enabled: true, transaction: async () => {}, ensureExternalSource: async () => null });

  const out = await repo.getChannelOrDefault(10, { uid: 7 });
  const refOut = await refRepo.getChannel(10, { uid: 7 });
  assert.strictEqual(out, row, 'returns the pg row verbatim');
  assert.strictEqual(refOut, row);
  assert.strictEqual(pool.calls.length, 1, 'explicit path is one query (delegates to getChannel)');

  const { sql, params } = pool.calls[0];
  assert.deepStrictEqual(params, [10, 7], 'same [id, uid] bindings as getChannel');
  assert.strictEqual(sql, ref.calls[0].sql, 'explicit path runs getChannel SQL verbatim');
  assert.match(sql, /WHERE id=\$1/i, 'explicit id filter');
  assert.match(sql, /owner_uid = \$2/i, 'channelAccessSql actor predicate on uid param $2');
  assert.match(sql, /status<>'disabled'/i, 'disabled channels not bypassable via explicit id');
});

test('getChannelOrDefault is defensive: missing uid and DB-off never query (default or explicit)', async () => {
  const pool = fakePool([{ id: 1 }]);
  const repo = createChannelsRepo({ pool, enabled: true, transaction: async () => {}, ensureExternalSource: async () => null });
  assert.strictEqual(await repo.getChannelOrDefault(0, {}), null, 'default, no uid → null');
  assert.strictEqual(await repo.getChannelOrDefault(10, {}), null, 'explicit, no uid → null');
  assert.strictEqual(await repo.getChannelOrDefault(0, null), null, 'default, no user → null');
  assert.strictEqual(pool.calls.length, 0, 'never query ownership blind');

  const off = fakePool([{ id: 1 }]);
  const offRepo = createChannelsRepo({ pool: off, enabled: false, transaction: async () => {}, ensureExternalSource: async () => null });
  assert.strictEqual(await offRepo.getChannelOrDefault(0, { uid: 7 }), null, 'DB off, default → null');
  assert.strictEqual(await offRepo.getChannelOrDefault(10, { uid: 7 }), null, 'DB off, explicit → null');
  assert.strictEqual(off.calls.length, 0, 'DB off never queries');
});
