#!/usr/bin/env node
/**
 * СВЕРКА ПИНОВ `requirements.txt` ↔ `requirements.lock` для Python-сервисов.
 *
 * Прод ставится ПО LOCK (`Dockerfile.mtproto` / `Dockerfile.collector`, `pip install --require-hashes
 * -r requirements.lock`), а `requirements.txt` — человекочитаемый источник. Dependabot умеет править
 * только txt: хешованный lock он перегенерировать не может. Значит его PR меняет ОДНУ строку в txt,
 * lock остаётся прежним, CI зелёный — и это правда, потому что `pip-audit -r ...lock` аудитит
 * неизменившийся lock. Зелёный такого PR означает «для прода ничего не изменилось», а вовсе не
 * «бамп доехал».
 *
 * Именно так и случилось: #424 подняла в txt `fastapi==0.141.1`, lock и прод остались на `0.140.0`,
 * и заметить это было нечем (аудит #554, найдено при разборе I-3).
 *
 * Гейт сверяет ТОЛЬКО те пакеты, что названы в txt точным пином `==`: диапазоны (`qrcode>=7.4,<9`)
 * lock разрешает сам, и сверять их нечего. Транзитивы в lock тоже не наше дело — они там для того
 * и лежат.
 *
 * Когда гейт красный, правильный ход — перегенерировать lock, а не подгонять txt:
 *   pip-compile --generate-hashes --output-file=<svc>/requirements.lock <svc>/requirements.txt
 * (python 3.12, pip-tools — та же команда написана в шапке каждого txt).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SERVICES = ['mtproto', 'collector'];
const root = process.cwd();

/** Точные пины источника: `name==version`, без комментариев и пустых строк. */
function sourcePins(text) {
  const pins = new Map();
  for (const line of text.split('\n')) {
    const clean = line.split('#')[0].trim();
    const m = clean.match(/^([A-Za-z0-9._-]+)\s*==\s*([^\s;]+)$/);
    if (m) pins.set(m[1].toLowerCase().replace(/[._]/g, '-'), m[2]);
  }
  return pins;
}

/** Пины lock: `name==version \` в начале строки (дальше идут хеши). */
function lockPins(text) {
  const pins = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z0-9._-]+)==([^\s\\]+)/);
    if (m) pins.set(m[1].toLowerCase().replace(/[._]/g, '-'), m[2]);
  }
  return pins;
}

const problems = [];
let checked = 0;
for (const svc of SERVICES) {
  const txtPath = join(root, svc, 'requirements.txt');
  const lockPath = join(root, svc, 'requirements.lock');
  if (!existsSync(txtPath) || !existsSync(lockPath)) continue;
  const src = sourcePins(readFileSync(txtPath, 'utf8'));
  const lock = lockPins(readFileSync(lockPath, 'utf8'));
  for (const [name, version] of src) {
    checked += 1;
    const locked = lock.get(name);
    if (locked == null) {
      problems.push(`${svc}: ${name}==${version} назван в requirements.txt, но в lock его нет`);
    } else if (locked !== version) {
      problems.push(
        `${svc}: ${name} — txt говорит ${version}, lock (и прод) держит ${locked}`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nПрод ставится по lock: расхождение значит, что бамп в txt до продакшена НЕ доехал.\n' +
      'Перегенерируй lock (python 3.12, pip-tools):\n' +
      '  pip-compile --generate-hashes --output-file=<service>/requirements.lock <service>/requirements.txt',
  );
  process.exit(1);
}
console.log(`Python-пины сходятся с lock: проверено ${checked} точных пина в ${SERVICES.join(', ')}.`);
