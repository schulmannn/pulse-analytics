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
