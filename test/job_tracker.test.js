'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobTracker } = require('../server/infrastructure/jobTracker');

test('job tracker waits for active work before becoming idle', async () => {
  let finish;
  const tracker = createJobTracker();
  tracker.run(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );

  await Promise.resolve();
  assert.equal(tracker.activeCount, 1);

  let drained = false;
  const waiting = tracker.waitForIdle({ timeoutMs: 1_000 }).then((result) => {
    drained = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);

  finish();
  assert.deepEqual(await waiting, { timedOut: false, pending: 0 });
  assert.equal(tracker.activeCount, 0);
});

test('job tracker rejects new work after drain starts', async () => {
  let called = false;
  const events = [];
  const tracker = createJobTracker({
    log: (level, event, fields) => events.push({ level, event, fields }),
  });

  tracker.beginDrain();
  const result = await tracker.run(
    () => {
      called = true;
    },
    { job: 'tail' },
  );

  assert.deepEqual(result, { accepted: false });
  assert.equal(called, false);
  assert.equal(tracker.isDraining, true);
  assert.equal(events[0].event, 'background_job_rejected_during_drain');
});
