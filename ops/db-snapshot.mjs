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

// ОДНО соединение + REPEATABLE READ (аудит P1): каждый SELECT раньше был отдельным autocommit-
// запросом — параллельные UPDATE/INSERT на живой базе могли продублировать или пропустить строки
// (страничный ORDER BY ctid LIMIT/OFFSET между снимками видел разные версии). Один транзакционный
// snapshot даёт консистентный срез ВСЕХ таблиц на момент BEGIN — снимать можно и под трафиком.
const client = await pool.connect();
try {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );

  const manifest = { taken_at: new Date().toISOString(), database: DATABASE_URL.replace(/:\/\/.*@/, '://***@'), tables: {} };

  for (const { table_name: t } of tables) {
    const out = createWriteStream(join(outDir, `${t}.jsonl`));
    let count = 0;
    // Постраничное чтение внутри REPEATABLE READ видит один и тот же snapshot — OFFSET-страницы
    // стабильны по построению (ctid неизменен в рамках снимка; конкурентные записи невидимы).
    const PAGE = 5000;
    for (let offset = 0; ; offset += PAGE) {
      const { rows } = await client.query(`SELECT * FROM "${t}" ORDER BY ctid LIMIT ${PAGE} OFFSET ${offset}`);
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

  await client.query('COMMIT');
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`snapshot written to ${outDir}`);
} finally {
  client.release();
}
await pool.end();
