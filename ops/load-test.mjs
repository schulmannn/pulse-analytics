// Capacity baseline driver (roadmap P0 «100 concurrent users»). N virtual users, EACH with their
// own minted token (the general rate limiter keys per uid — a single-token blaster would measure
// the limiter, not the app) and their own channel, loop a realistic read-mostly session:
//   auth/me → channels → history(400d) → tg/channel snapshot → [10%] PUT prefs
// Reports client-side p50/p95/p99 per endpoint + rps + errors, and samples pg_stat_activity /
// pg pool saturation server-side while the run is hot.
//
//   SESSION_SECRET=… BASE=http://localhost:3100 DATABASE_URL=… \
//     node ops/load-test.mjs --users 100 --seconds 30
//
// Seed the load preset first: node ops/seed-loadtest.mjs --preset load --wipe
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';

const args = process.argv.slice(2);
const USERS = Number(args[args.indexOf('--users') + 1] || 100);
const SECONDS = Number(args[args.indexOf('--seconds') + 1] || 30);
const BASE = process.env.BASE || 'http://localhost:3100';
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.error('SESSION_SECRET is required (must match the target server)');
  process.exit(1);
}

const mint = (uid) => {
  const body = Buffer.from(JSON.stringify({ uid, role: 'user', exp: Date.now() + 3600_000, ver: 0 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};

const agent = new http.Agent({ keepAlive: true, maxSockets: USERS * 2 });
const url = new URL(BASE);

function req(path, { method = 'GET', token, body } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const r = http.request(
      { agent, hostname: url.hostname, port: url.port, path, method,
        headers: {
          ...(token ? { 'x-session-token': token } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
      },
    );
    r.on('error', () => resolve({ status: 0, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

const lat = new Map(); // endpoint → number[]
const errs = new Map();
const record = (name, out) => {
  (lat.get(name) ?? lat.set(name, []).get(name)).push(out.ms);
  if (out.status !== 200) errs.set(name, (errs.get(name) ?? 0) + 1);
};

// Server-side saturation sampling while the run is hot.
const dbUrl = process.env.DATABASE_URL;
const pgPool = dbUrl ? new pg.Pool({ connectionString: dbUrl, max: 1, ssl: /localhost|127\.0\.0\.1/.test(dbUrl) ? false : { rejectUnauthorized: false } }) : null;
let peakBackends = 0;
const sampler = pgPool
  ? setInterval(async () => {
      try {
        const { rows: [r] } = await pgPool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle'`);
        peakBackends = Math.max(peakBackends, r.n);
      } catch { /* sampling is best-effort */ }
    }, 250)
  : null;

console.log(`load: ${USERS} users × ${SECONDS}s against ${BASE}`);
const deadline = Date.now() + SECONDS * 1000;
let iterations = 0;

async function virtualUser(i) {
  const uid = 1000 + (i % 100);          // seed users 1000..1099
  const channel = 5000 + (i % 300);      // seed channels 5000..5299 (spread across users)
  const token = mint(uid);
  while (Date.now() < deadline) {
    record('auth/me', await req('/api/auth/me', { token }));
    record('channels', await req('/api/channels', { token }));
    record('history-400d', await req(`/api/history/channel?channel=${channel}&days=400`, { token }));
    record('tg/channel(snapshot)', await req(`/api/tg/channel?channel=${channel}`, { token }));
    if (i % 10 === 0) {
      record('prefs PUT', await req('/api/prefs', { method: 'PUT', token, body: { prefs: { v: 1, load: i } } }));
    }
    iterations++;
  }
}

// NOTE on uid↔channel pairing: user (i%100) owns channels where channel%100 === uid%100 — the
// modulo spread guarantees the pairing (channel 5000+k belongs to user 1000+(k%100)).
const t0 = Date.now();
await Promise.all(Array.from({ length: USERS }, (_, i) => virtualUser(i)));
const wall = (Date.now() - t0) / 1000;
if (sampler) clearInterval(sampler);
if (pgPool) await pgPool.end();

const q = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]?.toFixed(1);
};
let total = 0;
console.log(`\n${'endpoint'.padEnd(22)} ${'n'.padStart(7)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'err'.padStart(5)}`);
for (const [name, arr] of [...lat.entries()].sort()) {
  total += arr.length;
  console.log(`${name.padEnd(22)} ${String(arr.length).padStart(7)} ${q(arr, 0.5).padStart(8)} ${q(arr, 0.95).padStart(8)} ${q(arr, 0.99).padStart(8)} ${String(errs.get(name) ?? 0).padStart(5)}`);
}
console.log(`\ntotal requests: ${total} (${(total / wall).toFixed(0)} rps over ${wall.toFixed(1)}s), full sessions: ${iterations}`);
if (peakBackends) console.log(`peak active DB backends during run: ${peakBackends} (server pool max=4)`);
