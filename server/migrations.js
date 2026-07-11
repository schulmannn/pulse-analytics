'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_ID = 18870625;

async function runMigrations(pool, logger = console) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(name => /^\d+_.+\.sql$/.test(name))
      .sort();

    // Дубль числового префикса (уже случилось: 013_crash_signatures + 013_ig_followers_total) —
    // мина: порядок держится только на лексикографике, и следующий автор может вклиниться между
    // дублями. Уже применённые файлы переименовывать НЕЛЬЗЯ (учёт по имени файла — переезд
    // перезапустил бы их на проде), поэтому громко предупреждаем, не роняя boot.
    const byPrefix = new Map();
    for (const file of files) {
      const prefix = file.match(/^(\d+)_/)[1];
      if (byPrefix.has(prefix)) {
        logger.error(`[db] MIGRATION NUMBERING CONFLICT: "${byPrefix.get(prefix)}" and "${file}" share prefix ${prefix} — use the next free number for new migrations`);
      } else {
        byPrefix.set(prefix, file);
      }
    }

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.log(`[db] migration applied: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        error.message = `migration ${file} failed: ${error.message}`;
        throw error;
      }
    }
    return files;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]); } catch (_) {}
    client.release();
  }
}

module.exports = { runMigrations, MIGRATIONS_DIR };
