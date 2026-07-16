// Гвард архитектурных границ backend'а (декомпозиция index.js, PR F).
// Ловит регресс к god-file: чистые слои не должны заново прорастать env-чтениями,
// таймерами, прямыми db-импортами и Express-знанием. Падает с ненулевым кодом и
// списком нарушений; зелёный — молчит. Часть `npm run check` (и CI).
//
// Контракты слоёв:
//  - app.js (HTTP-фабрика): БЕЗ process.env / .listen( / setInterval / process.on —
//    всё приходит в deps из composition.js.
//  - routes/**: БЕЗ прямого require db (инъекция) и БЕЗ вызовов *Internal( —
//    internal-ридеры (cron-доступ без ownership-чека) разрешены только jobs/сервисам.
//  - services/**, jobs/**: БЕЗ process.env, require('express'), setInterval — чистые
//    фабрики от deps; таймеры владение main.js/infrastructure (start/stop).
//  - infrastructure/**: БЕЗ process.env и express (таймеры МОЖНО — за start/stop).
//  - composition.js: собирает зависимости без env/listen/timers/signals.
//  - index.js: только dotenv + вызов main, не более 20 строк.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'server');
const errors = [];

const read = (p) => fs.readFileSync(p, 'utf8');
const listJs = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)) : [];
const listJsRecursive = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsRecursive(target);
        return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
      })
    : [];

// Правило = [regex, пояснение]. Комментарии из проверки не вычищаем сознательно:
// упоминание запретного API в комменте — дешёвая цена за простой и честный гвард,
// а ложные срабатывания правятся формулировкой комментария.
function forbid(file, rules) {
  const src = read(file);
  const rel = path.relative(process.cwd(), file);
  for (const [re, why] of rules) {
    const m = src.match(re);
    if (m) {
      const line = src.slice(0, m.index).split('\n').length;
      errors.push(`${rel}:${line} — ${why} (найдено: ${JSON.stringify(m[0].slice(0, 40))})`);
    }
  }
}

// Environment ownership is global, not merely a convention for selected layers.
// main.js/worker.js (process entrypoints) may expose process.env as a default argument and own
// process signals; config.js is the only parser.
for (const file of listJsRecursive(ROOT)) {
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  if (relative === 'config.js' || relative === 'main.js' || relative === 'worker.js') continue;
  forbid(file, [
    [/process\.env\b/, 'environment variables are parsed only by config.js'],
  ]);
}

// app.js — синхронная HTTP-фабрика без окружения/таймеров/сигналов/listen.
forbid(path.join(ROOT, 'app.js'), [
  [/process\.env\b/, 'app.js не читает process.env — конфиг приходит в deps'],
  [/\.listen\s*\(/, 'app.js не слушает порт — это main.js'],
  [/\bsetInterval\s*\(/, 'app.js не создаёт таймеров — это main/infrastructure'],
  [/process\.on\s*\(/, 'app.js не вешает process-сигналов — это main.js'],
]);

// main.js — lifecycle без Express-сборки.
forbid(path.join(ROOT, 'main.js'), [
  [/require\(\s*['"]express['"]\s*\)/, 'main.js не собирает Express — это app.js'],
]);

// routes/** — HTTP-слой на инъекции: без прямого db, без internal-ридеров, без env
// (бывший LEGACY_ENV_ALLOW закрыт: bugs/collector/ig-oauth получают значения из config через deps).
forbid(path.join(ROOT, 'main.js'), [
  [/require\(\s*['"]\.\/index(?:\.js)?['"]\s*\)/, 'main.js must not import the entrypoint'],
]);

forbid(path.join(ROOT, 'composition.js'), [
  [/process\.env\b/, 'composition.js receives validated config'],
  [/\.listen\s*\(/, 'composition.js does not open a port'],
  [/\bsetInterval\s*\(/, 'composition.js does not start timers'],
  [/process\.on\s*\(/, 'composition.js does not own process signals'],
]);

for (const f of listJs(path.join(ROOT, 'routes'))) {
  forbid(f, [
    [/require\(\s*['"]\.\.?\/(db)(\.js)?['"]\s*\)/, 'routes не импортят db напрямую — db инъектится'],
    [/\b\w+Internal\s*\(/, 'routes не зовут *Internal-ридеры (обход ownership-чека) — это привилегия jobs'],
    [/process\.env\b/, 'routes не читают process.env — конфиг приходит через deps'],
  ]);
}

// services/** и jobs/** — чистые фабрики.
for (const dir of ['services', 'jobs']) {
  for (const f of listJs(path.join(ROOT, dir))) {
    forbid(f, [
      [/process\.env\b/, `${dir} не читают process.env — только deps`],
      [/require\(\s*['"]express['"]\s*\)/, `${dir} не знают об Express`],
      [/\bsetInterval\s*\(/, `${dir} не создают таймеров — владение у main/infrastructure`],
      [/\.listen\s*\(/, `${dir} не слушают порт`],
    ]);
  }
}

// infrastructure/** — таймеры можно (за start/stop), env и Express — нет.
for (const f of listJs(path.join(ROOT, 'infrastructure'))) {
  forbid(f, [
    [/process\.env\b/, 'infrastructure не читает process.env — только deps'],
    [/require\(\s*['"]express['"]\s*\)/, 'infrastructure не знает об Express'],
  ]);
}

// index.js — минимальный process entrypoint, без сборки приложения.
{
  const p = path.join(ROOT, 'index.js');
  const n = read(p).split('\n').length;
  const CAP = 20;
  if (n > CAP) errors.push(`server/index.js — ${n} строк > ${CAP}: entrypoint должен только загружать env и вызывать main()`);
}

if (errors.length) {
  console.error('[boundaries] нарушения архитектурных границ:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('[boundaries] ok');
