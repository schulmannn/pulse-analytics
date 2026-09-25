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
    // Все совпадения, а не первое: гвард, показывающий одно нарушение из пяти, заставляет чинить
    // их по одному прогону на штуку и врёт о масштабе.
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of src.matchAll(global)) {
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

// Обход ВЕЗДЕ рекурсивный: nested-папка внутри routes/services молча оставалась вне гварда.
const REPOS_IMPORT = /require\(\s*['"]\.\.?\/(?:\.\.\/)?repos\//;
const SERVICES_IMPORT = /require\(\s*['"]\.\.?\/(?:\.\.\/)?services\//;

for (const f of listJsRecursive(path.join(ROOT, 'routes'))) {
  forbid(f, [
    [/require\(\s*['"]\.\.?\/(db)(\.js)?['"]\s*\)/, 'routes не импортят db напрямую — db инъектится'],
    // Дыра, которой уже воспользовались (routes/cdek.js тянул нормализаторы из repos/cdekRepo):
    // роут, знающий слой данных, обходит инъекцию и утаскивает за собой pg в HTTP-слой.
    [REPOS_IMPORT, 'routes не импортят repos — данные приходят через инъектированный db, чистые правила живут в domain/lib'],
    [/\b\w+Internal\s*\(/, 'routes не зовут *Internal-ридеры (обход ownership-чека) — это привилегия jobs'],
    [/process\.env\b/, 'routes не читают process.env — конфиг приходит через deps'],
  ]);
}

// services/** и jobs/** — чистые фабрики.
for (const dir of ['services', 'jobs']) {
  for (const f of listJsRecursive(path.join(ROOT, dir))) {
    forbid(f, [
      [/process\.env\b/, `${dir} не читают process.env — только deps`],
      [/require\(\s*['"]express['"]\s*\)/, `${dir} не знают об Express`],
      [REPOS_IMPORT, `${dir} не импортят repos — доступ к данным приходит через инъектированный db`],
      [/\bsetInterval\s*\(/, `${dir} не создают таймеров — владение у main/infrastructure`],
      [/\.listen\s*\(/, `${dir} не слушают порт`],
    ]);
  }
}

// infrastructure/** — таймеры можно (за start/stop), env и Express — нет.
for (const f of listJsRecursive(path.join(ROOT, 'infrastructure'))) {
  forbid(f, [
    [/process\.env\b/, 'infrastructure не читает process.env — только deps'],
    [/require\(\s*['"]express['"]\s*\)/, 'infrastructure не знает об Express'],
    [REPOS_IMPORT, 'infrastructure не импортит repos — зависимости приходят инъекцией'],
  ]);
}

// lib/**, domain/**, middleware/** — низ стека. У них правил не было ВОВСЕ, и это единственная
// причина, по которой «чистые» модули могли начать тянуть Express, репозитории или сервисы.
for (const dir of ['lib', 'domain', 'middleware']) {
  for (const f of listJsRecursive(path.join(ROOT, dir))) {
    forbid(f, [
      [/require\(\s*['"]express['"]\s*\)/, `${dir} не знает об Express — это низ стека`],
      [REPOS_IMPORT, `${dir} не импортит repos — иначе низ стека знает о доступе к данным`],
      [SERVICES_IMPORT, `${dir} не импортит services — зависимость снизу вверх`],
    ]);
  }
}

// db.js — фасад ДАННЫХ. Направление db → services было единственным местом, где нижний слой знал
// о верхнем: фабрика сервиса теперь приходит из composition.js инъекцией.
forbid(path.join(ROOT, 'db.js'), [
  [SERVICES_IMPORT, 'db.js не импортит services — фабрика приходит из composition через overrides'],
]);
for (const f of listJsRecursive(path.join(ROOT, 'db'))) {
  forbid(f, [
    [SERVICES_IMPORT, 'db/** не импортит services — зависимость снизу вверх'],
  ]);
}

// index.js — минимальный process entrypoint, без сборки приложения.
{
  const p = path.join(ROOT, 'index.js');
  const n = read(p).split('\n').length;
  const CAP = 20;
  if (n > CAP) errors.push(`server/index.js — ${n} строк > ${CAP}: entrypoint должен только загружать env и вызывать main()`);
}

// ── Циклы в графе require ────────────────────────────────────────────────────────────────────
// Цикл A→B→A переживает `node -e "require(...)"` (Node отдаёт полузаполненный module.exports) и
// проявляется позже как «undefined is not a function» в проде на редком пути. Сейчас циклов ноль —
// эта проверка фиксирует ноль, а не ищет его.
{
  const files = listJsRecursive(ROOT);
  const idOf = (p) => path.resolve(p);
  const graph = new Map();
  for (const file of files) {
    const src = read(file);
    const deps = [];
    for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const raw = path.resolve(path.dirname(file), m[1]);
      const candidates = [raw, `${raw}.js`, path.join(raw, 'index.js')];
      const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (hit) deps.push(idOf(hit));
    }
    graph.set(idOf(file), deps);
  }
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map([...graph.keys()].map((k) => [k, WHITE]));
  const stack = [];
  const seen = new Set();
  function visit(node) {
    color.set(node, GREY);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (!color.has(dep)) continue;                 // вне server/** — не наш граф
      if (color.get(dep) === GREY) {
        const from = stack.indexOf(dep);
        const cycle = [...stack.slice(from), dep].map((f) => path.relative(process.cwd(), f)).join(' → ');
        if (!seen.has(cycle)) { seen.add(cycle); errors.push(`цикл require: ${cycle}`); }
      } else if (color.get(dep) === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }
  for (const node of graph.keys()) if (color.get(node) === WHITE) visit(node);
}

if (errors.length) {
  console.error('[boundaries] нарушения архитектурных границ:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('[boundaries] ok');
