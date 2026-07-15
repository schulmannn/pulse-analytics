'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdmissionController } = require('../server/lib/admissionController');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('caps in-flight at maxInFlight and queues the overflow (exact concurrency)', async () => {
  const c = createAdmissionController({ maxInFlight: 2, acquireTimeoutMs: 1000 });
  const r1 = await c.acquire();
  const r2 = await c.acquire();
  assert.equal(c.inFlight, 2);

  let thirdGranted = false;
  const p3 = c.acquire().then((r) => { thirdGranted = true; return r; });
  await sleep(5);
  assert.equal(thirdGranted, false, 'third acquire must wait while the cap is full');
  assert.equal(c.waiting, 1);
  assert.equal(c.inFlight, 2, 'in-flight never exceeds the cap');

  r1();                     // free one → the queued waiter is granted, cap still respected
  const r3 = await p3;
  assert.equal(thirdGranted, true);
  assert.equal(c.inFlight, 2);
  assert.equal(c.waiting, 0);

  r2();
  r3();
  assert.equal(c.inFlight, 0);
});

test('queued acquires are granted in FIFO order as slots free', async () => {
  const c = createAdmissionController({ maxInFlight: 1, maxWaiting: 2, acquireTimeoutMs: 1000 });
  const r1 = await c.acquire();
  const order = [];
  const pA = c.acquire().then((r) => { order.push('A'); return r; });
  const pB = c.acquire().then((r) => { order.push('B'); return r; });
  await sleep(5);
  assert.equal(c.waiting, 2);

  r1();
  const rA = await pA;
  assert.deepEqual(order, ['A']);
  rA();
  const rB = await pB;
  assert.deepEqual(order, ['A', 'B']);
  rB();
  assert.equal(c.inFlight, 0);
});

test('overload rejects with a stable busy code after the acquire deadline', async () => {
  const c = createAdmissionController({ maxInFlight: 1, acquireTimeoutMs: 20 });
  const r1 = await c.acquire();
  await assert.rejects(
    () => c.acquire(),
    (e) => e && e.busy === true && e.code === 'busy',
  );
  assert.equal(c.waiting, 0, 'the timed-out waiter is removed from the queue');
  assert.equal(c.inFlight, 1, 'a rejected acquire never consumes a slot');
  r1();
  assert.equal(c.inFlight, 0);
});

test('bounds the waiting queue and rejects excess burst requests immediately', async () => {
  const c = createAdmissionController({ maxInFlight: 1, maxWaiting: 1, acquireTimeoutMs: 1000 });
  const release = await c.acquire();
  const queued = c.acquire();
  await sleep(5);
  assert.equal(c.waiting, 1);
  await assert.rejects(
    () => c.acquire(),
    (e) => e && e.busy === true && e.code === 'busy',
  );
  assert.equal(c.waiting, 1, 'rejected burst request never enters the bounded queue');
  release();
  const releaseQueued = await queued;
  releaseQueued();
  assert.equal(c.inFlight, 0);
});

test('a timed-out waiter never strands a permit (no leak)', async () => {
  const c = createAdmissionController({ maxInFlight: 1, acquireTimeoutMs: 20 });
  const r1 = await c.acquire();
  await assert.rejects(() => c.acquire());  // this waiter times out
  await sleep(10);
  r1();                                     // slot freed AFTER the waiter gave up
  assert.equal(c.inFlight, 0, 'the abandoned waiter did not grab the freed slot');
  const r2 = await c.acquire();             // slot is genuinely available again
  assert.equal(c.inFlight, 1);
  r2();
  assert.equal(c.inFlight, 0);
});

test('release is idempotent — a double release cannot free another holder’s slot', async () => {
  const c = createAdmissionController({ maxInFlight: 2, acquireTimeoutMs: 1000 });
  const r1 = await c.acquire();
  await c.acquire();          // r2 stays held
  assert.equal(c.inFlight, 2);
  r1();
  r1();                       // second release must be a no-op
  assert.equal(c.inFlight, 1, 'double release did not over-decrement the counter');
});

test('under an admitted burst the live count never exceeds the cap and drains to zero', async () => {
  const c = createAdmissionController({ maxInFlight: 3, maxWaiting: 9, acquireTimeoutMs: 2000 });
  let live = 0;
  let peak = 0;
  const work = async () => {
    const rel = await c.acquire();
    live += 1;
    peak = Math.max(peak, live);
    await sleep(10);
    live -= 1;
    rel();
  };
  await Promise.all(Array.from({ length: 12 }, work));
  assert.equal(peak, 3, 'exactly the cap ran concurrently at the peak');
  assert.equal(c.inFlight, 0);
  assert.equal(c.waiting, 0);
});

test('coerces invalid options to safe defaults and rejects out-of-bounds cap', () => {
  const d = createAdmissionController({ maxInFlight: 'nope', acquireTimeoutMs: undefined });
  assert.equal(d.maxInFlight, 8);
  assert.equal(d.maxWaiting, 8);
  assert.equal(d.acquireTimeoutMs, 2000);
  assert.throws(() => createAdmissionController({ maxInFlight: 0 }), /positive integer/);
  assert.throws(() => createAdmissionController({ maxWaiting: -1 }), />= 0/);
  assert.throws(() => createAdmissionController({ acquireTimeoutMs: -1 }), />= 0/);
});
