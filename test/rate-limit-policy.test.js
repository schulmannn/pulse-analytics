const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceRefreshLimitKey, createFixedWindowQuota } = require('../server/lib/rateLimitPolicy');

test('source refresh quota is keyed by source, not by teammate', () => {
  const sharedSource = { id: 10, workspace_id: 7, source_id: 99 };

  assert.strictEqual(
    sourceRefreshLimitKey({ session: { uid: 1 }, ip: '203.0.113.1', channel: sharedSource }),
    'src:99',
  );
  assert.strictEqual(
    sourceRefreshLimitKey({ session: { uid: 2 }, ip: '203.0.113.2', channel: sharedSource }),
    'src:99',
  );
});

test('source refresh quota falls back without a resolved source', () => {
  assert.strictEqual(
    sourceRefreshLimitKey({ session: { uid: 1 }, channel: { id: 5, workspace_id: 7 } }),
    'ws:7:ch:5',
  );
  assert.strictEqual(
    sourceRefreshLimitKey({ session: { uid: 1 }, ig: { accountId: '1784', channelId: 12 } }),
    'ig:ch:12',
  );
  assert.strictEqual(
    sourceRefreshLimitKey({ session: { uid: 1 }, ig: { accountId: '1784' } }),
    'ig:acct:1784',
  );
  assert.strictEqual(
    sourceRefreshLimitKey({ session: { uid: 1 }, ip: '198.51.100.7' }),
    'u:1',
  );
  assert.strictEqual(
    sourceRefreshLimitKey({ ip: '198.51.100.7' }),
    'ip:198.51.100.7',
  );
});

test('fixed-window source quota resets after the configured window', () => {
  let t = 1_000;
  const quota = createFixedWindowQuota({ windowMs: 1_000, max: 2, now: () => t });

  assert.deepStrictEqual(quota.consume('src:1'), {
    allowed: true,
    limit: 2,
    remaining: 1,
    resetAt: 2_000,
    retryAfterSeconds: 1,
  });
  assert.strictEqual(quota.consume('src:1').allowed, true);
  assert.strictEqual(quota.consume('src:1').allowed, false);

  t = 2_000;
  assert.strictEqual(quota.consume('src:1').allowed, true);
});
