// Logical snapshot of the whole public schema to a directory of JSONL files (one per table) +
// a manifest with row counts. Driver-only (the repo's own `pg`) — no pg_dump needed, so the drill
// runs anywhere Node runs. Good for the current data scale (test accounts / small teams); at real
// production scale switch to pg_dump (see ops/BACKUP_RESTORE.md §5).
//
//   DATABASE_URL=postgres://… node ops/db-snapshot.mjs [outDir]
//
// Output: <outDir>/<table>.jsonl + manifest.json (counts, schema_migrations versions, timestamp).
import pg from 'pg';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { sslForDatabase } from './db-ssl.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const outDir = process.argv[2] || `ops/snapshots/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(outDir, { recursive: true });

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2, ssl: sslForDatabase(DATABASE_URL) });

// JSON-safe encoding for the two non-JSON column families we use: bytea (bug screenshots) and
// dates/timestamps (ISO strings round-trip fine through node-pg on insert).
function encodeValue(v) {
  if (Buffer.isBuffer(v)) return { __bytea: v.toString('base64') };
  if (v instanceof Date) return v.toISOString();
  return v;
}

const { rows: tables } = await pool.query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
   ORDER BY table_name`,
);

const manifest = { taken_at: new Date().toISOString(), database: DATABASE_URL.replace(/:\/\/.*@/, '://***@'), tables: {} };

for (const { table_name: t } of tables) {
  const out = createWriteStream(join(outDir, `${t}.jsonl`));
  let count = 0;
  // Keyset-free paged read via OFFSET is fine at drill scale; ORDER BY ctid keeps it stable enough
  // for a quiesced database (take snapshots with the app stopped or during low traffic).
  const PAGE = 5000;
  for (let offset = 0; ; offset += PAGE) {
    const { rows } = await pool.query(`SELECT * FROM "${t}" ORDER BY ctid LIMIT ${PAGE} OFFSET ${offset}`);
    for (const row of rows) {
      const enc = {};
      for (const [k, v] of Object.entries(row)) enc[k] = encodeValue(v);
      out.write(JSON.stringify(enc) + '\n');
      count++;
    }
    if (rows.length < PAGE) break;
  }
  await new Promise((res) => out.end(res));
  manifest.tables[t] = count;
  console.log(`${t}: ${count} rows`);
}

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`snapshot written to ${outDir}`);
await pool.end();
