'use strict';

function createJobTracker({ log = () => {} } = {}) {
  const active = new Set();
  let draining = false;

  function run(task, fields = {}) {
    if (draining) {
      log('warn', 'background_job_rejected_during_drain', fields);
      return Promise.resolve({ accepted: false });
    }

    const tracked = Promise.resolve()
      .then(() => (typeof task === 'function' ? task() : task))
      .catch((error) => {
        log('error', 'background_job_failed', {
          ...fields,
          error: error && error.message,
        });
      })
      .finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  function beginDrain() {
    draining = true;
  }

  async function waitForIdle({ timeoutMs = 25_000 } = {}) {
    if (active.size === 0) return { timedOut: false, pending: 0 };

    let timer = null;
    const settled = Promise.allSettled([...active]).then(() => ({
      timedOut: false,
      pending: 0,
    }));
    const timeout = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ timedOut: true, pending: active.size }),
        timeoutMs,
      );
      timer.unref?.();
    });
    const result = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    if (result.timedOut)
      log('warn', 'background_jobs_drain_timeout', {
        pending: result.pending,
        timeout_ms: timeoutMs,
      });
    return result;
  }

  return {
    run,
    beginDrain,
    waitForIdle,
    get activeCount() {
      return active.size;
    },
    get isDraining() {
      return draining;
    },
  };
}

module.exports = { createJobTracker };
