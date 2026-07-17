// Shared TLS policy for the operator snapshot/restore/verify tools. It mirrors server/db/pool.js:
// Railway's private hostname stays plaintext, external `auto` verifies certificate + hostname,
// and encryption without identity verification requires an explicit `require` opt-in.
function sslForDatabase(url, env = process.env) {
  const mode = String(env.PGSSL || env.PGSSLMODE || 'auto').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'auto') {
    return /localhost|127\.0\.0\.1|\.railway\.internal/i.test(url)
      ? false
      : { rejectUnauthorized: true };
  }
  throw new Error('PGSSL/PGSSLMODE must be one of auto, disable, require, verify-full');
}

export { sslForDatabase };
