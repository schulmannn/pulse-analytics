'use strict';

const fetch = require('node-fetch');

// Every outbound HTTP call must carry a hard deadline: a hung upstream socket
// otherwise pins the caller's await (and the user's request) forever. node-fetch v2
// supports `timeout` natively — it aborts the request after `ms` of total time.
const DEFAULT_TIMEOUT_MS = 12000;

function fetchWithTimeout(url, opts = {}, ms = DEFAULT_TIMEOUT_MS) {
  return fetch(url, { ...opts, timeout: ms });
}

module.exports = { fetchWithTimeout, DEFAULT_TIMEOUT_MS };
