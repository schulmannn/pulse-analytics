import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('server');

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

const files = jsFiles(root).sort();
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}

if (failed) process.exitCode = 1;
else console.log(`[check:server] ${files.length} JavaScript files passed syntax check`);
