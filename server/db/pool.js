'use strict';

// DB core (P2 db/core): единственный источник PG-соединения — пул, Railway-SSL, флаг `enabled`,
// ping/close. Без DATABASE_URL или без модуля pg всё мягко деградирует (enabled=false, pool=null),
// дашборд работает как раньше. Извлечено дословно из db.js.

let Pool = null;
try { ({ Pool } = require('pg')); } catch (_e) { /* pg не установлен — БД выключена */ }

const DATABASE_URL = process.env.DATABASE_URL || '';
const enabled = !!(DATABASE_URL && Pool);

let pool = null;
if (enabled) {
  // SSL: Railway's PRIVATE url (*.railway.internal) needs NO ssl; external/public
  // managed Postgres usually does. Override with PGSSL=disable|require if needed.
  const internal = /\.railway\.internal/i.test(DATABASE_URL);
  const sslMode = (process.env.PGSSL || '').toLowerCase();
  let ssl;
  if (sslMode === 'disable') ssl = false;
  else if (sslMode === 'require') ssl = { rejectUnauthorized: false };
  else ssl = internal ? false : { rejectUnauthorized: false };   // smart default

  // Pool ceiling is the first infrastructure knob under load (ops/PERF_BASELINE.md): 4 keeps a
  // hobby Railway PG comfortable; raise via env (e.g. 8-10) as concurrent users grow.
  pool = new Pool({ connectionString: DATABASE_URL, ssl, max: Number(process.env.PGPOOL_MAX) || 4 });
  pool.on('error', (e) => console.error('[db] pool error:', e.message));
}

async function ping() {
  if (!enabled) return { enabled: false, ok: true };
  const started = Date.now();
  await pool.query('SELECT 1');
  return { enabled: true, ok: true, latency_ms: Date.now() - started };
}

async function close() {
  if (pool) await pool.end();
}

module.exports = { pool, enabled, DATABASE_URL, ping, close };
