// Deterministic synthetic dataset for capacity tests and backup drills. Presets:
//   drill    — 3 users / 5 channels / 90d daily / 500 posts (backup-restore drill scale)
//   load     — 100 users / 300 channels / 730d daily / ~100k posts (the «100 users» baseline)
//   load10x  — 1 000 users / 1 000 channels / 730d daily / ~730k channel_daily (1k-user horizon)
//   load100x — 10 000 users / 10 000 channels / 730d daily / ~7.3M channel_daily (10k-user horizon)
//
//   DATABASE_URL=… node ops/seed-loadtest.mjs --preset load10x [--wipe]
//
// --wipe truncates the seeded tables first (users cascade → everything tenant-scoped).
// Deterministic PRNG (LCG) → identical data on every run; safe to re-run WITHOUT --wipe thanks to
// ON CONFLICT DO NOTHING on every insert. NEVER run against a database you care about with --wipe.
// load100x is heavy (7.3M daily + 3.3M posts + 1M mentions) — expect minutes and ~3-4 GB on disk.
import pg from 'pg';
import { sslForDatabase } from './db-ssl.mjs';

const args = process.argv.slice(2);
const preset = args.includes('--preset') ? args[args.indexOf('--preset') + 1] : 'drill';
const wipe = args.includes('--wipe');

const P = {
  drill: { users: 3, channels: 5, days: 90, postsPerChannel: 100, mentionsPerChannel: 40 },
  load: { users: 100, channels: 300, days: 730, postsPerChannel: 334, mentionsPerChannel: 100 },
  load10x: { users: 1000, channels: 1000, days: 730, postsPerChannel: 334, mentionsPerChannel: 100 },
  load100x: { users: 10000, channels: 10000, days: 730, postsPerChannel: 334, mentionsPerChannel: 100 },
}[preset];
if (!P) {
  console.error(`unknown preset «${preset}» (drill | load | load10x | load100x)`);
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (/railway|amazonaws|azure/.test(DATABASE_URL) && wipe) {
  console.error('refusing --wipe against a hosted database — this flag is for local stands');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 4,
  ssl: sslForDatabase(DATABASE_URL),
});

// Seeded LCG — reproducible pseudo-randomness, no Math.random.
let seed = 20260704;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-04T00:00:00Z');
const dayISO = (d) => new Date(NOW - d * DAY).toISOString().slice(0, 10);

async function batchInsert(table, cols, rows, conflict = 'ON CONFLICT DO NOTHING') {
  if (rows.length === 0) return;
  const CHUNK = Math.max(1, Math.floor(900 / cols.length)); // stay under the 65k-param limit with margin
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params = [];
    const tuples = chunk.map((row, r) => {
      row.forEach((v) => params.push(v));
      const base = r * cols.length;
      return `(${cols.map((_, c) => `$${base + c + 1}`).join(',')})`;
    });
    await pool.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ${conflict}`,
      params,
    );
  }
}

console.log(`seeding preset=${preset}: ${P.users} users, ${P.channels} channels, ${P.days}d daily, ~${P.channels * P.postsPerChannel} posts`);

if (wipe) {
  // users cascades through channels → daily/posts/snapshots/mentions/prefs/reports via FKs.
  await pool.query(`TRUNCATE users CASCADE`);
  console.log('wiped');
}

// ── users (fixed ids 1000+ keep clear of real rows on shared stands) ──
const users = [];
for (let u = 0; u < P.users; u++) {
  users.push([1000 + u, `load${u}@seed.local`, 'seed:no-login', u === 0 ? 'superuser' : 'user', 'active', 0]);
}
await batchInsert('users', ['id', 'email', 'pass_hash', 'role', 'status', 'token_version'], users);

// ── channels: spread across users; all collector-sourced (snapshot-served — the read path a
//    multi-tenant load actually exercises; the single MTProto «central» channel stays untouched) ──
const channels = [];
for (let c = 0; c < P.channels; c++) {
  const owner = 1000 + (c % P.users);
  channels.push([5000 + c, owner, 100000000 + c, `seed_channel_${c}`, `Seed Channel ${c}`, 'active', 'collector']);
}
await batchInsert('channels', ['id', 'owner_uid', 'tg_channel_id', 'username', 'title', 'status', 'source'], channels);

// ── channel_daily: P.days rows per channel, wandering subscriber level ──
for (let c = 0; c < P.channels; c++) {
  const rows = [];
  let subs = ri(1000, 50000);
  for (let d = P.days - 1; d >= 0; d--) {
    const joins = ri(0, 60);
    const leaves = ri(0, 50);
    subs = Math.max(100, subs + joins - leaves);
    rows.push([5000 + c, dayISO(d), subs, joins, leaves, ri(500, 20000), ri(5, 400), ri(10, 900)]);
  }
  await batchInsert('channel_daily', ['channel_id', 'day', 'subscribers', 'joins', 'leaves', 'views', 'forwards', 'reactions'], rows);
  if (c % 50 === 0) console.log(`channel_daily: ${c + 1}/${P.channels}`);
}

// ── posts: spread over the window, plausible metrics ──
for (let c = 0; c < P.channels; c++) {
  const rows = [];
  for (let p = 0; p < P.postsPerChannel; p++) {
    const ageDays = rnd() * P.days;
    const views = ri(200, 30000);
    rows.push([
      5000 + c,
      1000 + p,
      new Date(NOW - ageDays * DAY).toISOString(),
      views,
      ri(0, Math.floor(views / 20)),
      ri(0, Math.floor(views / 50)),
      ri(0, 40),
      (rnd() * 12).toFixed(2),
      (rnd() * 4).toFixed(2),
      rnd() < 0.6 ? 'photo' : rnd() < 0.5 ? 'video' : 'text',
      `Seed post ${p} for channel ${c} — synthetic caption long enough to be realistic in list renders.`,
      JSON.stringify(rnd() < 0.3 ? ['#seed', '#load'] : []),
    ]);
  }
  await batchInsert(
    'posts',
    ['channel_id', 'post_id', 'date_published', 'views', 'reactions', 'forwards', 'replies', 'erv', 'virality', 'media_type', 'caption', 'hashtags'],
    rows,
  );
  if (c % 50 === 0) console.log(`posts: ${c + 1}/${P.channels}`);
}

// ── mentions (owner-scoped archive the mentions page reads) ──
for (let c = 0; c < P.channels; c++) {
  const rows = [];
  for (let m = 0; m < P.mentionsPerChannel; m++) {
    const when = new Date(NOW - rnd() * P.days * DAY).toISOString();
    rows.push([
      5000 + c, 200000 + ri(0, 99999), 1 + ri(0, 99999), when, when, when,
      `Mentioning channel ${m}`, `mention_src_${m}`, 'https://t.me/example', '…seed snippet…', ri(100, 9000), 'seed',
    ]);
  }
  await batchInsert(
    'mentions',
    ['owner_channel_id', 'channel_id', 'msg_id', 'post_date', 'first_seen', 'last_seen', 'title', 'username', 'link', 'snippet', 'views', 'query'],
    rows,
  );
}

// ── channel_snapshots: the JSON the collector path serves for /api/tg/* on these channels ──
for (let c = 0; c < P.channels; c++) {
  const posts = Array.from({ length: 25 }, (_, p) => ({
    id: 1000 + p,
    date: new Date(NOW - rnd() * 30 * DAY).toISOString(),
    views: ri(200, 30000),
    reactions: ri(0, 900),
    forwards: ri(0, 400),
    replies: ri(0, 40),
    media_type: 'photo',
    caption: `Snapshot post ${p}`,
  }));
  await pool.query(
    `INSERT INTO channel_snapshots (channel_id, data, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (channel_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [5000 + c, JSON.stringify({
      channel: { id: 100000000 + c, username: `seed_channel_${c}`, title: `Seed Channel ${c}`, memberCount: ri(1000, 50000) },
      posts,
      views_summary: { total_reactions: ri(100, 5000), total_forwards: ri(50, 900), total_replies: ri(10, 300), avg_views_by_type: { photo: ri(500, 5000) } },
    })],
  );
  await pool.query(
    `INSERT INTO collector_status (channel_id, collector_version, last_ingest_id, last_attempt_at, last_success_at, updated_at)
     VALUES ($1, 'seed-1.0', 'seed', NOW(), NOW(), NOW())
     ON CONFLICT (channel_id) DO UPDATE SET last_success_at = NOW(), updated_at = NOW()`,
    [5000 + c],
  );
}

// ── prefs + reports (the account-sync payloads every dashboard load reads) ──
const prefs = [];
const reports = [];
for (let u = 0; u < P.users; u++) {
  prefs.push([1000 + u, JSON.stringify({ v: 1, hidden: [], order: [], widgetConfigs: [] })]);
  reports.push([1000 + u, `Seed report ${u}`, JSON.stringify({ blocks: [{ id: 'b1', type: 'text', config: { text: 'seed' } }] }), 'none']);
}
await batchInsert('user_prefs', ['uid', 'prefs'], prefs, 'ON CONFLICT (uid) DO UPDATE SET prefs = EXCLUDED.prefs');
await batchInsert('reports', ['uid', 'name', 'config', 'schedule'], reports);

// Serial sequences past the fixed ids so app-created rows never collide with seed ids.
await pool.query(`SELECT setval(pg_get_serial_sequence('users','id'), GREATEST((SELECT MAX(id) FROM users), 2000), true)`);
await pool.query(`SELECT setval(pg_get_serial_sequence('channels','id'), GREATEST((SELECT MAX(id) FROM channels), 6000), true)`);

const { rows: [c1] } = await pool.query('SELECT COUNT(*)::int n FROM channel_daily');
const { rows: [c2] } = await pool.query('SELECT COUNT(*)::int n FROM posts');
console.log(`done: channel_daily=${c1.n}, posts=${c2.n}`);
await pool.end();
