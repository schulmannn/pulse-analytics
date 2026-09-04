#!/usr/bin/env node
// Трещотка предупреждений линтера — ярус между «гейт молчит» и «чинить 1156 штук сегодня».
//
// Гейт (`npm run lint`) валит только ОШИБКИ, поэтому предупреждения копились никем не считанные:
// аудит #554 намерил 1362 и отметил, что за два месяца выросли по каждому правилу, о котором
// память проекта писала цифру в июле. Долг без счётчика не долг, а фон.
//
// Здесь счётчик ПО ПРАВИЛАМ, а не общий: общий позволяет починить пять `useOptionalChain` и
// завести пять `noArrayIndexKey`, оставшись «в норме». Правило может только ужиматься.
//
//   node scripts/lint-debt.mjs             → сверка с baseline, exit 1 при росте
//   node scripts/lint-debt.mjs --update    → зафиксировать текущее (в CI НИКОГДА)
//
// ПОЧЕМУ ОБЪЯСНЕНИЕ ПРО `noRedundantUseStrict` ЖИВЁТ ЗДЕСЬ, А НЕ В biome.json: этот файл не
// принимает комментарии. Строка `// …` не ломает разбор с ошибкой — Biome МОЛЧА откатывается на
// ДЕФОЛТЫ: вместе с `files.includes` и всеми override'ами. Замерено на этой же ветке — с
// комментарием в конфиге в проверку попадали файлы вне includes, и 0 ошибок превращались в 275.
// Поэтому в biome.json только данные, а причины — тут.
//
// Правило `suspicious/noRedundantUseStrict` выключено для `server/**/*.js` и `test/**/*.js`
// (override в biome.json): это CommonJS — в package.json нет `"type": "module"`, — а файл CJS по
// умолчанию НЕ строгий, так что `'use strict'` там ОБЯЗАТЕЛЕН. Правило считает иначе, потому что
// предполагает ES-модуль. Опаснее самих 226 предупреждений то, что оно FIXABLE: `biome lint
// --write` вычистил бы директиву из всего сервера и молча перевёл его в sloppy mode.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'scripts', 'lint-debt-baseline.json');
const update = process.argv.includes('--update');

// Через JS-точку входа пакета, а не через шим в .bin: на Windows тот .cmd, и execFile без shell
// его не запускает, а с shell — не находит по относительному пути. Точка входа одна на все ОС.
const biome = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome');
let raw;
try {
  raw = execFileSync(process.execPath, [biome, 'lint', '--reporter=json', '--max-diagnostics=5000'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Biome выходит ненулевым, когда есть хоть одна находка — это норма, читаем stdout.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch (e) {
  raw = e.stdout ?? '';
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error('lint-debt: biome не отдал разбираемый JSON — гейт не может судить, и молчать не будет.');
  process.exit(1);
}

// Считаем ПРЕДУПРЕЖДЕНИЯ и info: ошибки уже валит `npm run lint`, дублировать их незачем.
const counts = {};
for (const d of report.diagnostics ?? []) {
  if (d.severity === 'error') continue;
  const rule = d.category;
  if (typeof rule !== 'string' || !rule.startsWith('lint/')) continue;
  counts[rule] = (counts[rule] ?? 0) + 1;
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);

// Пустой отчёт прошёл бы «зелёным» ни на чём — а он же и признак сломанной конфигурации.
if (report.summary?.unchanged === 0) {
  console.error('lint-debt: biome не проверил ни одного файла — конфигурация сломана.');
  process.exit(1);
}

if (update) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, `${JSON.stringify({ total, rules: sorted }, null, 2)}\n`);
  console.log(`baseline записан: ${total} предупреждений по ${Object.keys(sorted).length} правилам`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error('lint-debt: нет baseline. Запустите `node scripts/lint-debt.mjs --update`.');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

const grown = [];
const shrunk = [];
for (const rule of new Set([...Object.keys(counts), ...Object.keys(baseline.rules)])) {
  const now = counts[rule] ?? 0;
  const was = baseline.rules[rule] ?? 0;
  if (now > was) grown.push({ rule, was, now });
  else if (now < was) shrunk.push({ rule, was, now });
}

for (const { rule, was, now } of shrunk.sort((a, b) => a.now - a.was - (b.now - b.was))) {
  console.log(`  ужалось: ${rule}  ${was} → ${now}`);
}
if (shrunk.length) {
  console.log('  зафиксировать: node scripts/lint-debt.mjs --update\n');
}

if (grown.length) {
  console.error('Долг линтера вырос:\n');
  for (const { rule, was, now } of grown) console.error(`  ${rule}  ${was} → ${now}  (+${now - was})`);
  console.error(
    '\nПравило может только ужиматься. Почините новые находки — или, если рост осознан,' +
      '\nобновите baseline тем же скриптом и объясните рост в описании PR.',
  );
  process.exit(1);
}

console.log(`долг линтера: ${total} (потолок ${baseline.total}) — не вырос`);
