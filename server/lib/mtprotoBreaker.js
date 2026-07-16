'use strict';

// Exactly two internal lanes. Live dashboard reads and background collection sweeps trip and
// recover independently (a failing nightly QR sweep must not open the circuit on live reads, and
// vice versa), but they still share ONE global in-flight bulkhead — the single upstream mtproto
// (Telethon) process is the shared resource being protected. Any unknown/missing lane normalizes
// to 'live' so a caller that forgets the arg stays on the conservative default lane.
function normalizeLane(lane) {
  return lane === 'background' ? 'background' : 'live';
}

function createBreaker(opts = {}) {
  const {
    maxInFlight = 8,
    // Background sub-cap over the SAME global bulkhead. Background collection may never claim more
    // than this many of the global slots at once, so live dashboard reads always keep at least
    // (maxInFlight - backgroundMaxInFlight) slots to themselves even during a heavy sweep. Live is
    // NOT sub-capped — it may use the whole global pool when background is idle.
    backgroundMaxInFlight = 5,
    failureThreshold = 5,
    cooldownMs = 10000,
    halfOpenMax = 1,
    now = Date.now,
  } = opts;

  // Shared across ALL lanes — the global bulkhead over the single mtproto process.
  let inFlight = 0;
  // Subset of inFlight currently held by the background lane — the reservation counter behind the
  // background sub-cap. Tracked with the acquisition lease so every settlement path releases exactly
  // what it reserved (a legacy no-lease settle falls back to the queried lane).
  let backgroundInFlight = 0;

  // Per-lane circuit state / failure counters / cooldown / half-open trial accounting.
  const newLane = () => ({
    state: 'CLOSED',
    halfOpenInFlight: 0,
    consecutiveFailures: 0,
    openUntil: 0,
    generation: 0,
  });
  const lanes = { live: newLane(), background: newLane() };
  const laneOf = (lane) => lanes[normalizeLane(lane)];

  function refreshState(l) {
    if (l.state === 'OPEN' && now() >= l.openUntil) {
      l.state = 'HALF_OPEN';
      l.halfOpenInFlight = 0;
    }
  }

  function openCircuit(l) {
    l.state = 'OPEN';
    l.halfOpenInFlight = 0;
    l.openUntil = now() + cooldownMs;
    if (l.consecutiveFailures < failureThreshold) l.consecutiveFailures = failureThreshold;
    l.generation += 1;
  }

  function closeCircuit(l) {
    l.state = 'CLOSED';
    l.halfOpenInFlight = 0;
    l.consecutiveFailures = 0;
    l.openUntil = 0;
    l.generation += 1;
  }

  return {
    tryAcquire(lane) {
      const l = laneOf(lane);
      refreshState(l);

      if (l.state === 'OPEN') {
        return {
          ok: false,
          reason: 'open',
          retryAfterMs: Math.max(0, l.openUntil - now()),
        };
      }

      // Shared bulkhead first: a saturated global pool rejects across every lane.
      if (inFlight >= maxInFlight) {
        return { ok: false, reason: 'overloaded', retryAfterMs: 0 };
      }

      // Background sub-cap: reserve live headroom in the shared pool. A background acquisition is
      // rejected once the background lane already holds backgroundMaxInFlight slots, EVEN when the
      // global pool still has room — those remaining slots are the reservation for live reads.
      const background = normalizeLane(lane) === 'background';
      if (background && backgroundInFlight >= backgroundMaxInFlight) {
        return { ok: false, reason: 'overloaded', retryAfterMs: 0 };
      }

      if (l.state === 'HALF_OPEN' && l.halfOpenInFlight >= halfOpenMax) {
        return { ok: false, reason: 'overloaded', retryAfterMs: 0 };
      }

      const halfOpenTrial = l.state === 'HALF_OPEN';
      inFlight += 1;
      if (halfOpenTrial) l.halfOpenInFlight += 1;
      if (background) backgroundInFlight += 1;

      // Keep the public gate shape backward-compatible ({ ok: true }), while attaching an
      // acquisition lease for race-safe settlement. A request admitted in an older circuit
      // generation must not close a newer HALF_OPEN trial when it eventually finishes.
      const gate = { ok: true };
      Object.defineProperty(gate, 'lease', {
        enumerable: false,
        value: Object.freeze({
          lane: normalizeLane(lane),
          generation: l.generation,
          halfOpenTrial,
          background,
        }),
      });
      return gate;
    },

    onSettled(ok, lane, gate) {
      const lease = gate && gate.lease;
      const l = laneOf(lease ? lease.lane : lane);
      refreshState(l);
      // Direct callers from the legacy API have no lease and retain the old sequential
      // behavior. Production clients always pass the gate returned by tryAcquire.
      const halfOpenTrial = lease
        ? lease.halfOpenTrial
        : l.state === 'HALF_OPEN' && l.halfOpenInFlight > 0;
      if (inFlight > 0) inFlight -= 1;
      if (halfOpenTrial && l.halfOpenInFlight > 0) l.halfOpenInFlight -= 1;
      // Release the background reservation the matching acquisition took. With a lease, release
      // exactly what THIS request reserved (generation/state-independent — a background slot is held
      // for the whole request regardless of circuit transitions); a legacy no-lease settle falls
      // back to the queried lane.
      const wasBackground = lease ? lease.background : normalizeLane(lane) === 'background';
      if (wasBackground && backgroundInFlight > 0) backgroundInFlight -= 1;

      const belongsToCurrentGeneration =
        !lease ||
        (lease.generation === l.generation &&
          (halfOpenTrial ? l.state === 'HALF_OPEN' : l.state === 'CLOSED'));
      if (!belongsToCurrentGeneration) return;

      if (ok) {
        if (halfOpenTrial) {
          closeCircuit(l);
          return;
        }
        l.consecutiveFailures = 0;
        return;
      }

      if (halfOpenTrial) {
        openCircuit(l);
        return;
      }

      if (l.state === 'CLOSED') {
        l.consecutiveFailures += 1;
        if (l.consecutiveFailures >= failureThreshold) openCircuit(l);
      }
    },

    snapshot(lane) {
      const l = laneOf(lane);
      refreshState(l);
      return { state: l.state, inFlight, consecutiveFailures: l.consecutiveFailures };
    },
  };
}

module.exports = { createBreaker };
