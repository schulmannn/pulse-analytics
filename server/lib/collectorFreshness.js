'use strict';

const HOUR_MS = 60 * 60 * 1000;

const DEFAULT_THRESHOLDS = {
  collector: { delayedAfterHours: 6, staleAfterHours: 24 },
  tg: { delayedAfterHours: 6, staleAfterHours: 24 },
  ig: { delayedAfterHours: 12, staleAfterHours: 48 },
};

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeProvider(provider) {
  const p = String(provider || 'collector').toLowerCase();
  if (p === 'telegram') return 'tg';
  if (p === 'instagram') return 'ig';
  return p;
}

function collectorFreshnessThresholds(env = process.env, provider = 'collector') {
  const key = normalizeProvider(provider).replace(/[^a-z0-9]/g, '_').toUpperCase();
  const base = DEFAULT_THRESHOLDS[normalizeProvider(provider)] || DEFAULT_THRESHOLDS.collector;
  const delayedAfterHours = positiveNumber(
    env[`COLLECTOR_${key}_DELAYED_HOURS`] ?? env.COLLECTOR_DELAYED_HOURS,
    base.delayedAfterHours,
  );
  const staleAfterHours = Math.max(
    delayedAfterHours,
    positiveNumber(env[`COLLECTOR_${key}_STALE_HOURS`] ?? env.COLLECTOR_STALE_HOURS, base.staleAfterHours),
  );
  return { delayedAfterHours, staleAfterHours };
}

function latestFailureIsCurrent(status, lastAttemptMs, lastSuccessMs) {
  return !!status.last_error && (!lastSuccessMs || (lastAttemptMs && lastAttemptMs >= lastSuccessMs));
}

function collectorFreshness(status, options = {}) {
  if (!status) return null;
  const provider = normalizeProvider(options.provider);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const thresholds = options.thresholds || collectorFreshnessThresholds(process.env, provider);
  const delayedAfterHours = positiveNumber(thresholds.delayedAfterHours, DEFAULT_THRESHOLDS.collector.delayedAfterHours);
  const staleAfterHours = Math.max(
    delayedAfterHours,
    positiveNumber(thresholds.staleAfterHours, DEFAULT_THRESHOLDS.collector.staleAfterHours),
  );
  const suppressAlerts = !!options.suppressAlerts;
  const lastSuccessMs = status.last_success_at ? Date.parse(status.last_success_at) : 0;
  const lastAttemptMs = status.last_attempt_at ? Date.parse(status.last_attempt_at) : 0;
  const failed = latestFailureIsCurrent(status, lastAttemptMs, lastSuccessMs);

  let slaStatus = 'stale';
  let alertLevel = 'warn';
  let ageHours = null;
  if (failed) {
    slaStatus = 'failed';
    alertLevel = 'error';
  } else if (lastSuccessMs && Number.isFinite(lastSuccessMs)) {
    ageHours = Math.max(0, (nowMs - lastSuccessMs) / HOUR_MS);
    if (ageHours <= delayedAfterHours) {
      slaStatus = 'fresh';
      alertLevel = 'none';
    } else if (ageHours <= staleAfterHours) {
      slaStatus = 'delayed';
      alertLevel = 'warn';
    }
  }

  const breached = slaStatus !== 'fresh';
  const alert = breached && !suppressAlerts;
  return {
    provider,
    sla_status: slaStatus,
    alert_level: alert ? alertLevel : 'none',
    alert,
    alert_suppressed: breached && suppressAlerts,
    age_hours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
    delayed_after_hours: delayedAfterHours,
    stale_after_hours: staleAfterHours,
    stale: slaStatus === 'stale' || slaStatus === 'failed',
  };
}

module.exports = {
  collectorFreshness,
  collectorFreshnessThresholds,
  normalizeProvider,
};
