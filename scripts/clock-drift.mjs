#!/usr/bin/env node
// Сдвиг «сейчас» — проверка канона относительных дат в тестах.
//
// Канон репо: тест якорится на `Date.now()`, а не на литеральной дате, иначе он тихо протухает —
// зелёный сегодня, красный в марте. Аудит #554 записал «15 тестов с литеральными датами» в бэклог
// как подозрение; проверить его чтением нельзя (литеральная дата во ФИКСТУРЕ совершенно законна —
// вопрос в том, сравнивается ли она с текущим временем).
//
// Здесь вопрос решается ЭКСПЕРИМЕНТОМ: обе суиты гоняются с подменённым `Date` — «сейчас»
// сдвинуто вперёд. Тест, который на этом ломается, зависит от РЕАЛЬНОЙ даты, и его видно поимённо.
//
//   node scripts/clock-drift.mjs             → два сдвига (+187 дней и +2 года)
//   node scripts/clock-drift.mjs --days 400  → свой сдвиг
//
// НЕ в `npm run check` намеренно: это удвоение времени обеих суит ради проверки, которая меняется
// раз в квартал, а не раз в коммит. Запускать при подозрении и перед крупными волнами дат.
//
// Замер 2026-09-04 на #607: 1139 серверных и 1516 фронтовых тестов зелёные при ОБОИХ сдвигах.
// То есть литеральные даты в тестах — входные фикстуры, а не сравнение с «сейчас»; пункт бэклога
// закрыт замером, а не правкой.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.indexOf('--days');
const SHIFTS = arg > 0 ? [Number(process.argv[arg + 1])] : [187, 730];

const HOOK = (days) => `// Временный хук: «сейчас» +${days} дн.
const SHIFT = ${days} * 24 * 60 * 60 * 1000;
const RealDate = Date;
const now = () => RealDate.now() + SHIFT;
class ShiftedDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(now()); else super(...args); }
  static now() { return now(); }
}
globalThis.Date = ShiftedDate;
`;

const SETUP = (days) => `${HOOK(days)}export {};\n`;

let failed = false;
const scratch = [];
const tmp = mkdtempSync(join(tmpdir(), 'clock-drift-'));
try {
  for (const days of SHIFTS) {
    const hook = join(tmp, `hook-${days}.mjs`);
    writeFileSync(hook, HOOK(days));
    console.log(`\n── сдвиг +${days} дн. ───────────────────────────────────────────────`);

    // Серверная суита: подмена приезжает через --import ДО загрузки тестов.
    const server = run('node', ['--test', '--import', pathToFileURL(hook).href, 'test/*.test.js']);
    report('server', server);

    // Фронтовая: у vitest свой рантайм и НЕТ флага --setupFiles (CACError: Unknown option).
    // Поэтому кладём рядом с проектным конфигом временную пару «сетап + конфиг-надстройка» и
    // зовём `vitest --config`. Оба файла удаляются в finally, имена говорят сами за себя.
    const fe = join(root, 'frontend');
    const setup = join(fe, `.clock-drift.setup-${days}.ts`);
    const cfg = join(fe, `.clock-drift.config-${days}.ts`);
    writeFileSync(setup, SETUP(days));
    writeFileSync(cfg, [
      "import base from './vitest.config';",
      "import { mergeConfig } from 'vitest/config';",
      `export default mergeConfig(base, { test: { setupFiles: ['./.clock-drift.setup-${days}.ts'] } });`,
      '',
    ].join('\n'));
    scratch.push(setup, cfg);
    const front = run('npx', ['--no-install', 'vitest', 'run', '--config', cfg], fe);
    report('frontend', front);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  for (const f of scratch) rmSync(f, { force: true });
}

// `npx` на Windows — .cmd-шим, и execFile без shell его не запускает. Shell включаем ТОЛЬКО для
// него: аргументы здесь наши собственные (пути из mkdtemp), пользовательского ввода в них нет.
function run(cmd, args, cwd = root) {
  const opts = { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  if (process.platform === 'win32' && cmd === 'npx') opts.shell = true;
  try {
    return { ok: true, out: execFileSync(cmd, args, opts) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}

/** Только вердикт и — если красное — имена упавших файлов: остальное шум. */
function report(label, result) {
  if (result.ok) {
    const pass = /pass (\d+)|Tests\s+(\d+) passed/.exec(result.out);
    console.log(`  ${label}: зелено${pass ? ` (${pass[1] ?? pass[2]})` : ''}`);
    return;
  }
  failed = true;
  console.error(`  ${label}: КРАСНОЕ — тесты зависят от реальной даты:`);
  for (const line of result.out.split('\n')) {
    if (/^✖ |FAIL |not ok /.test(line.trim())) console.error(`    ${line.trim()}`);
  }
}

if (failed) {
  console.error('\nТест, упавший от сдвига часов, якорится на литеральной дате. Канон — Date.now-якорь.');
  process.exit(1);
}
console.log('\nОбе суиты переживают сдвиг часов: литеральные даты в тестах — фикстуры, а не «сейчас».');
