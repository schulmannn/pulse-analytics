import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateMigrationFiles } from './migration-numbering.mjs';

const migrationsDir = resolve('server', 'migrations');

const files = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
  .map((entry) => entry.name)
  .sort();
const errors = validateMigrationFiles(files);

if (errors.length) {
  console.error('[check:migrations] invalid migration numbering:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log(`[check:migrations] ${files.length} migrations passed numbering check`);
}
