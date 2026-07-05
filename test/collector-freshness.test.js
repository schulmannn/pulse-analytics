const test = require('node:test');
const assert = require('node:assert/strict');
const { collectorFreshness, collectorFreshnessThresholds } = require('../server/lib/collectorFreshness');

const NOW = Date.parse('2026-07-05T12:00:00Z');

function status(overrides = {}) {
  return {
    last_attempt_at: '2026-07-05T11:50:00Z',
    last_success_at: '2026-07-05T10:00:00Z',
    last_error: null,
    ...overrides,
  };
}

test('collector freshness classifies fresh, delayed and stale by provider thresholds', () => {
  const thresholds = { delayedAfterHours: 6, staleAfterHours: 24 };

  assert.equal(collectorFreshness(status(), { nowMs: NOW, thresholds }).sla_status, 'fresh');
  assert.equal(
    collectorFreshness(status({ last_success_at: '2026-07-05T00:00:00Z' }), { nowMs: NOW, thresholds }).sla_status,
    'delayed',
  );
  assert.equal(
    collectorFreshness(status({ last_success_at: '2026-07-03T00:00:00Z' }), { nowMs: NOW, thresholds }).sla_status,
    'stale',
  );
});

test('collector freshness treats a current failed attempt as failed until a later success clears it', () => {
  assert.equal(
    collectorFreshness(status({
      last_attempt_at: '2026-07-05T11:50:00Z',
      last_success_at: '2026-07-05T10:00:00Z',
      last_error: 'Graph timeout',
    }), { nowMs: NOW, thresholds: { delayedAfterHours: 6, staleAfterHours: 24 } }).sla_status,
    'failed',
  );
  assert.equal(
    collectorFreshness(status({
      last_attempt_at: '2026-07-05T09:50:00Z',
      last_success_at: '2026-07-05T10:00:00Z',
      last_error: 'old timeout',
    }), { nowMs: NOW, thresholds: { delayedAfterHours: 6, staleAfterHours: 24 } }).sla_status,
    'fresh',
  );
});

test('collector freshness suppresses alert noise during known outages without hiding state', () => {
  const out = collectorFreshness(status({
    last_success_at: '2026-07-03T00:00:00Z',
  }), {
    nowMs: NOW,
    thresholds: { delayedAfterHours: 6, staleAfterHours: 24 },
    suppressAlerts: true,
  });

  assert.equal(out.sla_status, 'stale');
  assert.equal(out.alert, false);
  assert.equal(out.alert_level, 'none');
  assert.equal(out.alert_suppressed, true);
});

test('collector freshness thresholds support provider-specific env overrides', () => {
  const thresholds = collectorFreshnessThresholds({
    COLLECTOR_DELAYED_HOURS: '6',
    COLLECTOR_STALE_HOURS: '24',
    COLLECTOR_IG_DELAYED_HOURS: '18',
    COLLECTOR_IG_STALE_HOURS: '72',
  }, 'ig');

  assert.deepEqual(thresholds, { delayedAfterHours: 18, staleAfterHours: 72 });
});
