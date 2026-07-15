const test = require('node:test');
const assert = require('node:assert/strict');
const { createBreaker } = require('../server/lib/mtprotoBreaker');

test('closed calls acquire and settle back to zero in-flight', () => {
  let clock = 1000;
  const breaker = createBreaker({ now: () => clock });

  assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
  assert.deepStrictEqual(breaker.snapshot(), {
    state: 'CLOSED',
    inFlight: 1,
    consecutiveFailures: 0,
  });

  breaker.onSettled(true);

  assert.deepStrictEqual(breaker.snapshot(), {
    state: 'CLOSED',
    inFlight: 0,
    consecutiveFailures: 0,
  });
});

test('bulkhead rejects calls beyond maxInFlight', () => {
  let clock = 1000;
  const breaker = createBreaker({ maxInFlight: 2, now: () => clock });

  assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
  assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });

  assert.deepStrictEqual(breaker.tryAcquire(), {
    ok: false,
    reason: 'overloaded',
    retryAfterMs: 0,
  });
});

test('consecutive failures trip the circuit open', () => {
  let clock = 1000;
  const breaker = createBreaker({ failureThreshold: 3, cooldownMs: 10000, now: () => clock });

  for (let i = 0; i < 3; i += 1) {
    assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
    breaker.onSettled(false);
  }

  const gate = breaker.tryAcquire();
  assert.strictEqual(gate.ok, false);
  assert.strictEqual(gate.reason, 'open');
  assert.ok(gate.retryAfterMs > 0);
  assert.deepStrictEqual(breaker.snapshot(), {
    state: 'OPEN',
    inFlight: 0,
    consecutiveFailures: 3,
  });
});

test('success resets consecutive failures before threshold', () => {
  let clock = 1000;
  const breaker = createBreaker({ failureThreshold: 3, now: () => clock });

  for (let i = 0; i < 2; i += 1) {
    assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
    breaker.onSettled(false);
  }
  assert.deepStrictEqual(breaker.snapshot(), {
    state: 'CLOSED',
    inFlight: 0,
    consecutiveFailures: 2,
  });

  assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
  breaker.onSettled(true);
  assert.deepStrictEqual(breaker.snapshot(), {
    state: 'CLOSED',
    inFlight: 0,
    consecutiveFailures: 0,
  });

  for (let i = 0; i < 2; i += 1) {
    assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
    breaker.onSettled(false);
  }
  assert.deepStrictEqual(breaker.snapshot(), {
    state: 'CLOSED',
    inFlight: 0,
    consecutiveFailures: 2,
  });
});

test('cooldown allows a half-open trial that closes on success', () => {
  let clock = 1000;
  const breaker = createBreaker({ failureThreshold: 2, cooldownMs: 10000, halfOpenMax: 1, now: () => clock });

  for (let i = 0; i < 2; i += 1) {
    assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
    breaker.onSettled(false);
  }

  clock += 10001;
  assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
  assert.deepStrictEqual(breaker.snapshot(), {
    state: 'HALF_OPEN',
    inFlight: 1,
    consecutiveFailures: 2,
  });

  breaker.onSettled(true);

  assert.deepStrictEqual(breaker.snapshot(), {
    state: 'CLOSED',
    inFlight: 0,
    consecutiveFailures: 0,
  });
});

test('half-open trial failure reopens with a fresh cooldown', () => {
  let clock = 1000;
  const breaker = createBreaker({ failureThreshold: 2, cooldownMs: 10000, halfOpenMax: 1, now: () => clock });

  for (let i = 0; i < 2; i += 1) {
    assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
    breaker.onSettled(false);
  }

  clock += 10001;
  assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
  breaker.onSettled(false);

  const reopened = breaker.tryAcquire();
  assert.strictEqual(reopened.ok, false);
  assert.strictEqual(reopened.reason, 'open');
  assert.strictEqual(reopened.retryAfterMs, 10000);
});

test('retryAfterMs shrinks while the circuit is open', () => {
  let clock = 1000;
  const breaker = createBreaker({ failureThreshold: 1, cooldownMs: 10000, now: () => clock });

  assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
  breaker.onSettled(false);

  assert.deepStrictEqual(breaker.tryAcquire(), {
    ok: false,
    reason: 'open',
    retryAfterMs: 10000,
  });

  clock += 4000;

  assert.deepStrictEqual(breaker.tryAcquire(), {
    ok: false,
    reason: 'open',
    retryAfterMs: 6000,
  });
});

// ── Lane isolation (live vs background) ──────────────────────────────────────

test('background failures open ONLY the background lane; live stays closed', () => {
  let clock = 1000;
  const breaker = createBreaker({ failureThreshold: 3, cooldownMs: 10000, now: () => clock });

  for (let i = 0; i < 3; i += 1) {
    assert.deepStrictEqual(breaker.tryAcquire('background'), { ok: true });
    breaker.onSettled(false, 'background');
  }

  const bg = breaker.tryAcquire('background');
  assert.strictEqual(bg.ok, false);
  assert.strictEqual(bg.reason, 'open');
  assert.deepStrictEqual(breaker.snapshot('background'), {
    state: 'OPEN',
    inFlight: 0,
    consecutiveFailures: 3,
  });

  // Live lane untouched by the background outage — it can still acquire.
  assert.deepStrictEqual(breaker.snapshot('live'), {
    state: 'CLOSED',
    inFlight: 0,
    consecutiveFailures: 0,
  });
  assert.deepStrictEqual(breaker.tryAcquire('live'), { ok: true });
});

test('live genuine failures open ONLY the live lane; background stays closed', () => {
  let clock = 1000;
  const breaker = createBreaker({ failureThreshold: 3, cooldownMs: 10000, now: () => clock });

  for (let i = 0; i < 3; i += 1) {
    assert.deepStrictEqual(breaker.tryAcquire('live'), { ok: true });
    breaker.onSettled(false, 'live');
  }

  assert.strictEqual(breaker.tryAcquire('live').reason, 'open');
  assert.deepStrictEqual(breaker.snapshot('background'), {
    state: 'CLOSED',
    inFlight: 0,
    consecutiveFailures: 0,
  });
  assert.deepStrictEqual(breaker.tryAcquire('background'), { ok: true });
});

test('the global in-flight bulkhead is SHARED: it rejects across lanes', () => {
  let clock = 1000;
  const breaker = createBreaker({ maxInFlight: 2, now: () => clock });

  assert.deepStrictEqual(breaker.tryAcquire('live'), { ok: true });
  assert.deepStrictEqual(breaker.tryAcquire('background'), { ok: true });

  // Both lanes are CLOSED, but the shared pool is full → rejected regardless of lane.
  assert.deepStrictEqual(breaker.tryAcquire('background'), {
    ok: false,
    reason: 'overloaded',
    retryAfterMs: 0,
  });
  assert.deepStrictEqual(breaker.tryAcquire('live'), {
    ok: false,
    reason: 'overloaded',
    retryAfterMs: 0,
  });

  // snapshot reports the shared inFlight regardless of which lane is queried.
  assert.strictEqual(breaker.snapshot('live').inFlight, 2);
  assert.strictEqual(breaker.snapshot('background').inFlight, 2);

  breaker.onSettled(true, 'live');
  assert.deepStrictEqual(breaker.tryAcquire('background'), { ok: true });
});

test('half-open trials are per-lane and recover that lane independently', () => {
  let clock = 1000;
  const breaker = createBreaker({ failureThreshold: 2, cooldownMs: 10000, halfOpenMax: 1, now: () => clock });

  // Trip both lanes open.
  for (const lane of ['live', 'background']) {
    for (let i = 0; i < 2; i += 1) {
      assert.deepStrictEqual(breaker.tryAcquire(lane), { ok: true });
      breaker.onSettled(false, lane);
    }
    assert.strictEqual(breaker.snapshot(lane).state, 'OPEN');
  }

  clock += 10001;

  // A successful background half-open trial closes background only; live's half-open trial
  // then fails and reopens live only.
  assert.deepStrictEqual(breaker.tryAcquire('background'), { ok: true });
  assert.strictEqual(breaker.snapshot('background').state, 'HALF_OPEN');
  breaker.onSettled(true, 'background');
  assert.strictEqual(breaker.snapshot('background').state, 'CLOSED');

  assert.deepStrictEqual(breaker.tryAcquire('live'), { ok: true });
  assert.strictEqual(breaker.snapshot('live').state, 'HALF_OPEN');
  breaker.onSettled(false, 'live');
  assert.strictEqual(breaker.snapshot('live').state, 'OPEN');
  assert.strictEqual(breaker.snapshot('background').state, 'CLOSED', 'background stayed closed');
});

test('unknown/missing lane normalizes to live', () => {
  let clock = 1000;
  const breaker = createBreaker({ failureThreshold: 2, now: () => clock });

  // Failures on an unknown lane land on live.
  assert.deepStrictEqual(breaker.tryAcquire('nope'), { ok: true });
  breaker.onSettled(false, 'nope');
  assert.deepStrictEqual(breaker.tryAcquire(), { ok: true });
  breaker.onSettled(false);
  assert.strictEqual(breaker.snapshot().state, 'OPEN', 'default snapshot() reads the live lane');
  assert.strictEqual(breaker.snapshot('background').state, 'CLOSED');
});

test('a stale closed request cannot settle a newer half-open generation', () => {
  let clock = 1000;
  const breaker = createBreaker({ failureThreshold: 1, cooldownMs: 10000, now: () => clock });

  // Both requests were admitted while CLOSED. The second one fails first and opens the circuit.
  const stale = breaker.tryAcquire('live');
  const trip = breaker.tryAcquire('live');
  breaker.onSettled(false, 'live', trip);
  assert.strictEqual(breaker.snapshot('live').state, 'OPEN');

  clock += 10001;
  const probe = breaker.tryAcquire('live');
  assert.strictEqual(breaker.snapshot('live').state, 'HALF_OPEN');

  // The old request succeeds after the cooldown. It belongs to the previous generation and must
  // not be mistaken for the half-open probe (the pre-lane implementation had this race).
  breaker.onSettled(true, 'live', stale);
  assert.strictEqual(breaker.snapshot('live').state, 'HALF_OPEN');

  breaker.onSettled(false, 'live', probe);
  assert.strictEqual(breaker.snapshot('live').state, 'OPEN');
  assert.strictEqual(breaker.snapshot('live').inFlight, 0);
});
