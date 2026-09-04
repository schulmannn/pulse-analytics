#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  Atlavue — запуск бэкенд-суиты: юниты параллельно, интеграция последовательно
// ═══════════════════════════════════════════════════════════════
// ЗАЧЕМ. `node --test test/*.test.js` гоняет ФАЙЛЫ параллельно (по числу ядер), а интеграционные
// файлы делят ОДНУ базу. Отсюда гонки, не имеющие отношения к коду: соседний файл каскадно удаляет
// свой канал между SELECT и INSERT чужой свёртки, partial unique index channels_one_central
// конфликтует между файлами. Это не гипотеза: обе гонки воспроизведены при аудите #554.
//
// Юниты (без БД) остаются параллельными — их 1200+, и последовательный прогон стоил бы минуты.
// Разделение по суффиксу `.integration.test.js`, потому что именно он и означает «ходит в БД».
//
// Запуск: node scripts/run-tests.mjs [дополнительные аргументы node --test]

import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();
const integration = files.filter((f) => f.endsWith('.integration.test.js'));
const unit = files.filter((f) => !f.endsWith('.integration.test.js'));

const extra = process.argv.slice(2);

function run(label, list, args) {
  if (!list.length) return Promise.resolve(0);
  const argv = ['--test', ...args, ...extra, ...list.map((f) => path.join('test', f))];
  process.stdout.write(`\n── ${label}: ${list.length} файлов ──\n`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    child.on('error', () => resolve(1));
  });
}

// Интеграция идёт ПЕРВОЙ и последовательно: падение схемы/базы должно быть видно сразу, а не
// после двух минут юнитов.
const integrationCode = await run('Интеграция (одна база, последовательно)', integration, ['--test-concurrency=1']);
const unitCode = await run('Юниты (параллельно)', unit, []);

process.exit(integrationCode || unitCode);
