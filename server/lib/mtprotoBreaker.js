'use strict';

function createBreaker(opts = {}) {
  const {
    maxInFlight = 8,
    failureThreshold = 5,
    cooldownMs = 10000,
    halfOpenMax = 1,
    now = Date.now,
  } = opts;

  let state = 'CLOSED';
  let inFlight = 0;
  let halfOpenInFlight = 0;
  let consecutiveFailures = 0;
  let openUntil = 0;

  function refreshState() {
    if (state === 'OPEN' && now() >= openUntil) {
      state = 'HALF_OPEN';
      halfOpenInFlight = 0;
    }
  }

  function openCircuit() {
    state = 'OPEN';
    halfOpenInFlight = 0;
    openUntil = now() + cooldownMs;
    if (consecutiveFailures < failureThreshold) consecutiveFailures = failureThreshold;
  }

  function closeCircuit() {
    state = 'CLOSED';
    halfOpenInFlight = 0;
    consecutiveFailures = 0;
    openUntil = 0;
  }

  return {
    tryAcquire() {
      refreshState();

      if (state === 'OPEN') {
        return {
          ok: false,
          reason: 'open',
          retryAfterMs: Math.max(0, openUntil - now()),
        };
      }

      if (inFlight >= maxInFlight) {
        return { ok: false, reason: 'overloaded', retryAfterMs: 0 };
      }

      if (state === 'HALF_OPEN' && halfOpenInFlight >= halfOpenMax) {
        return { ok: false, reason: 'overloaded', retryAfterMs: 0 };
      }

      inFlight += 1;
      if (state === 'HALF_OPEN') halfOpenInFlight += 1;
      return { ok: true };
    },

    onSettled(ok) {
      refreshState();
      const halfOpenTrial = state === 'HALF_OPEN' && halfOpenInFlight > 0;
      if (inFlight > 0) inFlight -= 1;
      if (halfOpenTrial) halfOpenInFlight -= 1;

      if (ok) {
        if (halfOpenTrial) {
          closeCircuit();
          return;
        }
        consecutiveFailures = 0;
        return;
      }

      if (halfOpenTrial) {
        openCircuit();
        return;
      }

      if (state === 'CLOSED') {
        consecutiveFailures += 1;
        if (consecutiveFailures >= failureThreshold) openCircuit();
      }
    },

    snapshot() {
      refreshState();
      return { state, inFlight, consecutiveFailures };
    },
  };
}

module.exports = { createBreaker };
