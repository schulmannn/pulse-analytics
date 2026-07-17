// Post-restore verification: row count per table + newest data day for the time-series tables —
// compare against the snapshot's manifest.json (pass its path to diff automatically).
//
//   DATABASE_URL=postgres://… node ops/db-verify.mjs [snapshotDir]
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sslForDatabase } from './db-ssl.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2, ssl: sslForDatabase(DATABASE_URL) });

const manifest = process.argv[2] ? JSON.parse(readFileSync(join(process.argv[2], 'manifest.json'), 'utf8')) : null;

const FRESHNESS = {
  channel_daily: 'day',
  ig_daily: 'day',
  velocity_daily: 'day',
  posts: 'date_published',
  mentions: 'post_date',
};

const { rows: tables } = await pool.query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
);

let mismatches = 0;
for (const { table_name: t } of tables) {
  const { rows: [{ count }] } = await pool.query(`SELECT COUNT(*)::int AS count FROM "${t}"`);
  let fresh = '';
  if (FRESHNESS[t]) {
    const { rows: [r] } = await pool.query(`SELECT MAX("${FRESHNESS[t]}") AS latest FROM "${t}"`);
    fresh = r.latest ? `  latest ${FRESHNESS[t]}=${r.latest instanceof Date ? r.latest.toISOString().slice(0, 10) : r.latest}` : '';
  }
  const expected = manifest?.tables?.[t];
  const mark = expected == null ? ' ' : expected === count ? 'ok' : 'MISMATCH';
  if (mark === 'MISMATCH') mismatches++;
  console.log(`${mark.padEnd(9)} ${t.padEnd(24)} ${String(count).padStart(8)}${expected != null && expected !== count ? ` (manifest: ${expected})` : ''}${fresh}`);
}
await pool.end();
if (mismatches > 0) {
  console.error(`\n${mismatches} table(s) differ from the manifest.`);
  process.exit(1);
}
console.log('\nverification passed');
