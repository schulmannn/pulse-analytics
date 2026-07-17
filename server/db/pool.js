'use strict';

let DefaultPool = null;
try {
  ({ Pool: DefaultPool } = require('pg'));
} catch (_error) {
  // Postgres is optional in DB-less development and tests.
}

// Maps a libpq-style sslmode to a pg `ssl` option. `require` intentionally follows PostgreSQL
// semantics: encryption without server-identity verification. `verify-full` validates both the
// certificate chain and hostname. Safe `auto` keeps Railway's private network plaintext, but treats
// every external database as verify-full; operators of a private/self-signed external endpoint must
// opt into the weaker `require` mode explicitly instead of inheriting a silent MITM risk.
function resolveSsl(connectionString, sslMode = 'auto') {
  const mode = String(sslMode || 'auto').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'auto') {
    return /\.railway\.internal/i.test(connectionString)
      ? false
      : { rejectUnauthorized: true };
  }
  throw new Error('unsupported Postgres SSL mode');
}

function createPool(
  {
    url = '',
    sslMode = 'auto',
    poolMax = 10,
    connectionTimeoutMs = 3000,
    statementTimeoutMs = 30000,
    queryTimeoutMs = 35000,
  } = {},
  { PoolClass = DefaultPool, onError = console.error } = {},
) {
  const enabled = !!(url && PoolClass);
  const pool = enabled
    ? new PoolClass({
        connectionString: url,
        ssl: resolveSsl(url, sslMode),
        max: poolMax,
        // Fail-fast under load: cap connection acquisition and per-statement/query time so a
        // saturated pool or a runaway query surfaces as an error instead of hanging a request.
        // db/errors maps the pool acquisition timeout to a 503 (не дублируем здесь).
        connectionTimeoutMillis: connectionTimeoutMs,
        statement_timeout: statementTimeoutMs,
        query_timeout: queryTimeoutMs,
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
