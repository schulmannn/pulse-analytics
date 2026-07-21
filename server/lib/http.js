'use strict';

// Every outbound HTTP call must carry a hard deadline: a hung upstream socket
// otherwise pins the caller's await (and the user's request) forever. Native fetch
// (Node ≥18, engines-пин в package.json) + AbortSignal.timeout повторяют семантику
// node-fetch v2 `timeout` (общий дедлайн на запрос); сам node-fetch выпилен.
// Явный opts.signal вызывающего уважается и имеет приоритет над дедлайном.
const DEFAULT_TIMEOUT_MS = 12000;

function fetchWithTimeout(url, opts = {}, ms = DEFAULT_TIMEOUT_MS) {
  return fetch(url, { signal: AbortSignal.timeout(ms), ...opts });
}

module.exports = { fetchWithTimeout, DEFAULT_TIMEOUT_MS };
