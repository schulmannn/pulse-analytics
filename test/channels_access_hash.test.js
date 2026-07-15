'use strict';

// Focused unit tests for the channels repo's Telegram entity-identity read/write used by the managed
// QR-collection warm path (getTgChannelIdentity / saveTgChannelAccessHash). A fake pool captures the
// SQL + params — no Postgres — so we assert the generation guard is present and that unsafe int64
// values (channel id + access_hash) are bound as exact strings, never coerced through a JS Number.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChannelsRepo } = require('../server/repos/channelsRepo');

function makeRepo({ rowCount = 1, rows = [] } = {}) {
  const calls = [];
  const pool = {
    query: async (text, params) => { calls.push({ text, params }); return { rowCount, rows }; },
  };
  const repo = createChannelsRepo({
    pool,
    enabled: true,
    transaction: async (fn) => fn(pool),
    ensureExternalSource: async () => null,
  });
  return { repo, calls };
}

test('getTgChannelIdentity selects the identity columns by owner-scoped id and returns the row untouched', async () => {
  const row = { tg_channel_id: '-1001234567890', tg_access_hash: '9223372036854775807', tg_access_hash_version: '4' };
  const { repo, calls } = makeRepo({ rows: [row] });

  const out = await repo.getTgChannelIdentity(77, 12);

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /FROM channels WHERE id=\$1 AND owner_uid=\$2/);
  assert.deepEqual(calls[0].params, [77, 12]);
  // The 64-bit values pass straight through as strings (pg returns BIGINT as text) — no rounding.
  assert.equal(out.tg_access_hash, '9223372036854775807');
});

test('getTgChannelIdentity returns null for a missing id / disabled db without querying', async () => {
  const { repo, calls } = makeRepo({ rows: [] });
  assert.equal(await repo.getTgChannelIdentity(0), null);
  assert.equal(await repo.getTgChannelIdentity(null), null);
  assert.equal(await repo.getTgChannelIdentity(1, null), null);
  assert.equal(calls.length, 0, 'no query for a falsy id');
});

test('public channel list/detail projections never include the stored access_hash', async () => {
  const { repo, calls } = makeRepo({ rows: [] });
  await repo.listChannels({ uid: 7 });
  await repo.getChannel(42, { uid: 7 });

  assert.equal(calls.length, 2);
  for (const { text } of calls) {
    assert.doesNotMatch(text, /tg_access_hash/i);
    assert.doesNotMatch(text, /tg_access_hash_version/i);
  }
});

test('saveTgChannelAccessHash writes with a monotonic generation guard and binds exact int64 strings', async () => {
  const { repo, calls } = makeRepo({ rowCount: 1 });
  const HASH = '9223372036854775807';   // 2**63 - 1: unsafe as a JS Number
  const GEN = '9';

  const ok = await repo.saveTgChannelAccessHash(42, 7, HASH, GEN);

  assert.equal(ok, true);
  const { text, params } = calls[0];
  assert.match(text, /UPDATE channels/);
  assert.match(text, /SET tg_access_hash = \$3, tg_access_hash_version = \$4/);
  assert.match(text, /c\.owner_uid = \$2/);
  // Generation guard: the owner must still be on this exact session generation, and the stored
  // identity may not be newer.
  assert.match(text, /FROM tg_sessions s/);
  assert.match(text, /s\.uid = c\.owner_uid AND s\.session_version = \$4::bigint/);
  assert.match(text, /tg_access_hash_version IS NULL OR c\.tg_access_hash_version <= \$4::bigint/);
  // Only stamps real TG channels, and skips redundant no-op writes.
  assert.match(text, /tg_channel_id IS NOT NULL/);
  assert.match(text, /IS DISTINCT FROM/);
  // Params bound as exact strings — never Number(HASH), which would round.
  assert.deepEqual(params, [42, 7, HASH, GEN]);
  assert.equal(params[2], HASH);
});

test('saveTgChannelAccessHash coerces non-string gen/hash to exact decimal strings', async () => {
  const { repo, calls } = makeRepo({ rowCount: 1 });
  // A caller may pass a numeric generation; it must be bound as a string, and a safe-range value
  // must still round-trip exactly.
  await repo.saveTgChannelAccessHash(1, 7, 4242, 9);
  assert.deepEqual(calls[0].params, [1, 7, '4242', '9']);
});

test('saveTgChannelAccessHash returns false (no write) on missing args', async () => {
  const { repo, calls } = makeRepo({ rowCount: 1 });
  assert.equal(await repo.saveTgChannelAccessHash(null, 7, '1', '1'), false);
  assert.equal(await repo.saveTgChannelAccessHash(1, null, '1', '1'), false);
  assert.equal(await repo.saveTgChannelAccessHash(1, 7, null, '1'), false);
  assert.equal(await repo.saveTgChannelAccessHash(1, 7, '1', null), false);
  assert.equal(calls.length, 0);
});

test('saveTgChannelAccessHash reports rowCount=0 (guard rejected an older-generation clobber) as false', async () => {
  const { repo } = makeRepo({ rowCount: 0 });
  // The SQL guard matched no row — e.g. a newer generation already wrote a hash. Not an error; the
  // caller swallows it and the value is simply left as the newer one.
  assert.equal(await repo.saveTgChannelAccessHash(42, 7, '1', '1'), false);
});
