'use strict';

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

// Expensive upstream refreshes should be shared by the data source, not by the
// person looking at the dashboard. That lets many teammates read normally while
// one hot source cannot repeatedly refetch Telegram/Graph.
function sourceRefreshLimitKey({ session, ip, channel, ig } = {}) {
  if (channel && hasValue(channel.source_id)) return `src:${channel.source_id}`;
  if (ig && hasValue(ig.channelId)) return `ig:ch:${ig.channelId}`;
  if (ig && hasValue(ig.accountId)) return `ig:acct:${ig.accountId}`;
  if (channel && hasValue(channel.workspace_id) && hasValue(channel.id)) {
    return `ws:${channel.workspace_id}:ch:${channel.id}`;
  }
  if (channel && hasValue(channel.id)) return `ch:${channel.id}`;
  if (session && Number.isInteger(session.uid)) return `u:${session.uid}`;
  return `ip:${ip || 'unknown'}`;
}

function createFixedWindowQuota({ windowMs, max, now = () => Date.now(), maxBuckets = 1000 } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be positive');
  if (!Number.isFinite(max) || max <= 0) throw new Error('max must be positive');
  const buckets = new Map();

  function prune(t) {
    if (buckets.size <= maxBuckets) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= t) buckets.delete(key);
      if (buckets.size <= maxBuckets) break;
    }
  }

  function consume(key) {
    const t = now();
    const safeKey = String(key || 'unknown');
    let bucket = buckets.get(safeKey);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(safeKey, bucket);
      prune(t);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= max,
      limit: max,
      remaining: Math.max(0, max - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - t) / 1000)),
    };
  }

  return { consume, _buckets: buckets };
}

module.exports = { sourceRefreshLimitKey, createFixedWindowQuota };
