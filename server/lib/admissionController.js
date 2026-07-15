'use strict';

// Process-local bounded admission controller — a fair FIFO semaphore that caps how many in-flight
// sections may fan out to slow external providers at once, and fast-fails the rest after a short
// acquire deadline instead of letting requests pile onto the upstream.
//
// One web replica is the enforced topology (WEB_REPLICAS=1, ADR-002), so an in-memory counter is
// authoritative — there is no shared state to coordinate across processes. Two safety properties the
// callers depend on:
//   • no permit leak — a grant that lands AFTER its waiter already timed out is immediately handed
//     to the next waiter (or returned to the pool), so a rejected caller never strands a slot;
//   • release-once — the returned release() is idempotent, so a caller can only ever free the single
//     slot it holds. Together these keep the live count within [0, maxInFlight] exactly.
//
// This bounds concurrency ACROSS callers; it never parallelises the dependent work inside one
// caller. Callers must release() in a finally so redirects, throws and early returns all free the slot.

function coerceInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function createAdmissionController(options = {}) {
  const maxInFlight = coerceInt(options.maxInFlight, 8);
  const acquireTimeoutMs = coerceInt(options.acquireTimeoutMs, 2000);
  const maxWaiting = coerceInt(options.maxWaiting, maxInFlight);
  if (maxInFlight < 1) throw new Error('admissionController: maxInFlight must be a positive integer');
  if (acquireTimeoutMs < 0) throw new Error('admissionController: acquireTimeoutMs must be >= 0');
  if (maxWaiting < 0) throw new Error('admissionController: maxWaiting must be >= 0');

  let inFlight = 0;
  const waiters = []; // FIFO queue of pending grants

  // pump() moves free slots to the oldest waiters. It increments inFlight BEFORE calling grant(),
  // so a waiter that has already timed out simply returns the slot (see grant()).
  function pump() {
    while (inFlight < maxInFlight && waiters.length > 0) {
      const w = waiters.shift();
      inFlight += 1;
      w.grant();
    }
  }

  function makeRelease() {
    let released = false;
    return function release() {
      if (released) return; // release-once: a double release must not free someone else's slot
      released = true;
      inFlight -= 1;
      pump();
    };
  }

  function acquire() {
    return new Promise((resolve, reject) => {
      // Fast path: a slot is free right now.
      if (inFlight < maxInFlight) {
        inFlight += 1;
        resolve(makeRelease());
        return;
      }
      // Bound pending HTTP work as well as provider fan-out. A timeout alone limits how long a
      // waiter lives, but not how many requests a burst can allocate during that window.
      if (waiters.length >= maxWaiting) {
        const e = new Error('admission_busy');
        e.busy = true;
        e.code = 'busy';
        reject(e);
        return;
      }
      // Slow path: queue and race the acquire deadline.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        const e = new Error('admission_busy');
        e.busy = true; // stable, non-secret signal — callers map it to a safe "retry later" response
        e.code = 'busy';
        reject(e);
      }, acquireTimeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      const waiter = {
        grant() {
          // pump() has already counted this slot in inFlight.
          if (settled) {
            // Waiter timed out before the slot arrived: hand the slot straight to the next waiter.
            inFlight -= 1;
            pump();
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(makeRelease());
        },
      };
      waiters.push(waiter);
    });
  }

  return Object.freeze({
    acquire,
    maxInFlight,
    maxWaiting,
    acquireTimeoutMs,
    get inFlight() {
      return inFlight;
    },
    get waiting() {
      return waiters.length;
    },
  });
}

module.exports = { createAdmissionController };
