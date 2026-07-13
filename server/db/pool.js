'use strict';

let DefaultPool = null;
try {
  ({ Pool: DefaultPool } = require('pg'));
} catch (_error) {
  // Postgres is optional in DB-less development and tests.
}

function resolveSsl(connectionString, sslMode = 'auto') {
  const mode = String(sslMode || 'auto').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  return /\.railway\.internal/i.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

function createPool(
  { url = '', sslMode = 'auto', poolMax = 4 } = {},
  { PoolClass = DefaultPool, onError = console.error } = {},
) {
  const enabled = !!(url && PoolClass);
  const pool = enabled
    ? new PoolClass({
        connectionString: url,
        ssl: resolveSsl(url, sslMode),
        max: poolMax,
      })
    : null;

  if (pool) {
    pool.on('error', (error) =>
      onError('[db] pool error:', error && error.message),
    );
  }

  async function ping() {
    if (!enabled) return { enabled: false, ok: true };
    const started = Date.now();
    await pool.query('SELECT 1');
    return {
      enabled: true,
      ok: true,
      latency_ms: Date.now() - started,
    };
  }

  async function close() {
    if (pool) await pool.end();
  }

  return Object.freeze({ pool, enabled, ping, close });
}

module.exports = { createPool, resolveSsl };
