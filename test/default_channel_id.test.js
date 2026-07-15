'use strict';

// Db-less unit guard for channelsRepo.getDefaultChannelId — the lightweight default-channel pick on
// the auth/tenant hot path (resolveChannel). The whole point of this method is to NOT drag the
// per-channel analytics that listChannels computes onto every authenticated request, so we capture
// the SQL a fake pool receives and assert the auth query stays cheap: no memberCount, no correlated
// channel_daily analytics subquery, no ig_accounts EXISTS. Real tenancy semantics (owner/member/
// viewer/outsider, disabled, legacy fallback, listChannels parity) live in the PG integration suite.

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

test('getDefaultChannelId issues one lightweight query — no memberCount/analytics/ig_accounts', async () => {
  const pool = fakePool([{ id: 42 }]);
  const repo = createChannelsRepo({ pool, enabled: true, transaction: async () => {}, ensureExternalSource: async () => null });

  const id = await repo.getDefaultChannelId({ uid: 7 });
  assert.strictEqual(id, 42, 'returns the bare channel id');
  assert.strictEqual(pool.calls.length, 1, 'exactly one query — no fan-out');

  const { sql, params } = pool.calls[0];
  assert.deepStrictEqual(params, [7], 'explicit uid input, single param');
  // The auth query must not compute any of listChannels'/getChannel-detail's per-row extras.
  assert.doesNotMatch(sql, /memberCount/i, 'no memberCount projection');
  assert.doesNotMatch(sql, /channel_daily/i, 'no correlated analytics subquery');
  assert.doesNotMatch(sql, /ig_accounts/i, 'no ig_connected EXISTS');
  assert.doesNotMatch(sql, /subscribers/i, 'no analytics columns');
  // …but it must keep the exact visibility + hiding + ordering contract.
  assert.match(sql, /UNION/i, 'same owner ∪ workspace-member visibility set as listChannels');
  assert.match(sql, /workspace_members/i, 'workspace membership branch present');
  assert.match(sql, /status<>'disabled'/i, 'disabled channels hidden');
  assert.match(sql, /ORDER BY created_at ASC/i, 'same default order as listChannels');
  assert.match(sql, /LIMIT 1/i, 'stops at the first accessible channel');
});

test('getDefaultChannelId is defensive: missing uid and DB-off both return null without querying', async () => {
  const pool = fakePool([{ id: 1 }]);
  const repo = createChannelsRepo({ pool, enabled: true, transaction: async () => {}, ensureExternalSource: async () => null });
  assert.strictEqual(await repo.getDefaultChannelId({}), null, 'no uid → null (never query ownership blind)');
  assert.strictEqual(await repo.getDefaultChannelId(null), null, 'no user → null');

  const off = createChannelsRepo({ pool: fakePool([]), enabled: false, transaction: async () => {}, ensureExternalSource: async () => null });
  assert.strictEqual(await off.getDefaultChannelId({ uid: 7 }), null, 'DB off → null');
});

test('getDefaultChannelId returns null when the user has no accessible channel', async () => {
  const pool = fakePool([]);
  const repo = createChannelsRepo({ pool, enabled: true, transaction: async () => {}, ensureExternalSource: async () => null });
  assert.strictEqual(await repo.getDefaultChannelId({ uid: 7 }), null, 'empty result → null (middleware → empty payload)');
});
