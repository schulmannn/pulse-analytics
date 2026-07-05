// Restore a snapshot taken by ops/db-snapshot.mjs into an EXISTING schema (run migrations first:
// `node server/migrate.js`). Truncates every snapshotted table, re-inserts all rows in FK-safe
// (topological) order, then resets serial sequences. Refuses to run against a database whose
// schema_migrations is BEHIND the snapshot's (restore onto older code = undefined behaviour).
//
//   DATABASE_URL=postgres://… node ops/db-restore.mjs <snapshotDir> [--yes]
//
// --yes skips the 5-second abort window (for scripted drills).
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';

const DATABASE_URL = process.env.DATABASE_URL;
const dir = process.argv[2];
if (!DATABASE_URL || !dir) {
  console.error('usage: DATABASE_URL=… node ops/db-restore.mjs <snapshotDir> [--yes]');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

function sslFor(url) {
  if (process.env.PGSSL === 'disable') return false;
  if (process.env.PGSSL === 'require') return { rejectUnauthorized: false };
  if (/localhost|127\.0\.0\.1|\.railway\.internal/.test(url)) return false;
  return { rejectUnauthorized: false };
}
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2, ssl: sslFor(DATABASE_URL) });

function decodeValue(v) {
  if (v && typeof v === 'object' && typeof v.__bytea === 'string') return Buffer.from(v.__bytea, 'base64');
  return v;
}

// ── safety: destructive action, visible countdown unless --yes ──
if (!process.argv.includes('--yes')) {
  console.log(`About to TRUNCATE ${Object.keys(manifest.tables).length} tables in ${DATABASE_URL.replace(/:\/\/.*@/, '://***@')}`);
  console.log('and restore the snapshot taken at', manifest.taken_at);
  console.log('Ctrl+C within 5s to abort…');
  await new Promise((r) => setTimeout(r, 5000));
  readline.moveCursor(process.stdout, 0, 0);
}

// FK topology: parents first. information_schema gives child->parent edges.
const { rows: fkRows } = await pool.query(`
  SELECT tc.table_name AS child, ccu.table_name AS parent
  FROM information_schema.table_constraints tc
  JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
`);
const tables = Object.keys(manifest.tables);
const parentsOf = new Map(tables.map((t) => [t, new Set()]));
for (const { child, parent } of fkRows) {
  if (parentsOf.has(child) && child !== parent && parentsOf.has(parent)) parentsOf.get(child).add(parent);
}
const ordered = [];
const seen = new Set();
function visit(t, chain = new Set()) {
  if (seen.has(t)) return;
  if (chain.has(t)) return; // FK cycle — insertion order best-effort, constraints are deferrable-free here
  chain.add(t);
  for (const p of parentsOf.get(t) ?? []) visit(p, chain);
  seen.add(t);
  ordered.push(t);
}
tables.forEach((t) => visit(t));

const client = await pool.connect();
try {
  await client.query('BEGIN');

  // Guard: never restore a NEWER snapshot onto an OLDER schema.
  if (manifest.tables.schema_migrations != null) {
    const snapVersions = readFileSync(join(dir, 'schema_migrations.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).version).sort();
    const { rows: dbv } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    const dbVersions = dbv.map((r) => r.version);
    const missing = snapVersions.filter((v) => !dbVersions.includes(v));
    if (missing.length > 0) {
      throw new Error(`target schema is missing migrations present in the snapshot: ${missing.join(', ')} — run \`node server/migrate.js\` first`);
    }
  }

  // Truncate children-last is unnecessary — one CASCADE statement handles the graph atomically.
  const quoted = tables.filter((t) => t !== 'schema_migrations').map((t) => `"${t}"`).join(', ');
  await client.query(`TRUNCATE ${quoted} CASCADE`);

  for (const t of ordered) {
    if (t === 'schema_migrations') continue; // versions belong to the migration runner, not the data
    const file = join(dir, `${t}.jsonl`);
    let lines;
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      console.warn(`skip ${t}: no file in snapshot`);
      continue;
    }
    // json/jsonb params must go over the wire as STRINGS: node-pg serialises a JS Array parameter
    // as a Postgres array literal ({...}), which is invalid json — the classic pg gotcha.
    const { rows: colTypes } = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [t],
    );
    const jsonCols = new Set(colTypes.filter((c) => c.data_type === 'json' || c.data_type === 'jsonb').map((c) => c.column_name));
    let n = 0;
    for (const line of lines) {
      const row = JSON.parse(line);
      const cols = Object.keys(row);
      const vals = cols.map((c) => {
        const v = decodeValue(row[c]);
        return jsonCols.has(c) && v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const params = cols.map((_, i) => `$${i + 1}`).join(', ');
      await client.query(
        `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${params})`,
        vals,
      );
      n++;
    }
    if (n !== manifest.tables[t]) {
      throw new Error(`${t}: inserted ${n}, manifest says ${manifest.tables[t]}`);
    }
    console.log(`${t}: ${n} rows`);
  }

  // Serial sequences: continue after the highest restored id.
  const { rows: seqCols } = await client.query(`
    SELECT c.table_name, c.column_name, pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) AS seq
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_default LIKE 'nextval%'
  `);
  for (const { table_name, column_name, seq } of seqCols) {
    if (!seq || !tables.includes(table_name)) continue;
    await client.query(
      `SELECT setval($1, COALESCE((SELECT MAX("${column_name}") FROM "${table_name}"), 0) + 1, false)`,
      [seq],
    );
  }

  await client.query('COMMIT');
  console.log('restore complete');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('restore FAILED (rolled back):', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
