// Гвард архитектурных границ backend'а (декомпозиция index.js, PR F).
// Ловит регресс к god-file: чистые слои не должны заново прорастать env-чтениями,
// таймерами, прямыми db-импортами и Express-знанием. Падает с ненулевым кодом и
// списком нарушений; зелёный — молчит. Часть `npm run check` (и CI).
//
// Контракты слоёв:
//  - app.js (HTTP-фабрика): БЕЗ process.env / .listen( / setInterval / process.on —
//    всё приходит в deps из композиционного корня (index.js).
//  - routes/**: БЕЗ прямого require db (инъекция) и БЕЗ вызовов *Internal( —
//    internal-ридеры (cron-доступ без ownership-чека) разрешены только jobs/сервисам.
//  - services/**, jobs/**: БЕЗ process.env, require('express'), setInterval — чистые
//    фабрики от deps; таймеры владение main.js/infrastructure (start/stop).
//  - infrastructure/**: БЕЗ process.env и express (таймеры МОЖНО — за start/stop).
//  - index.js: композиционный корень ≤ 300 строк (полный распил довёл до ~250 —
//    рост выше лимита значит, что в корень снова потекла логика, а не сборка).

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'server');
const errors = [];

const read = (p) => fs.readFileSync(p, 'utf8');
const listJs = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)) : [];

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

// routes/** — HTTP-слой на инъекции: без прямого db и без internal-ридеров.
// LEGACY_ENV_ALLOW: унаследованные env-чтения, жившие в этих роутах ДО декомпозиции
// (bugs: deploy-sha; collector: COLLECTOR_STALE_HOURS; ig-oauth: IG_CLIENT_ID/SECRET).
// Задокументированный долг — вынести в config при следующем содержательном касании
// файла; НОВЫЕ env-чтения в остальных роутах гвард ловит сразу.
const LEGACY_ENV_ALLOW = new Set(['bugs.js', 'collector.js', 'ig-oauth.js']);
for (const f of listJs(path.join(ROOT, 'routes'))) {
  const rules = [
    [/require\(\s*['"]\.\.?\/(db)(\.js)?['"]\s*\)/, 'routes не импортят db напрямую — db инъектится'],
    [/\b\w+Internal\s*\(/, 'routes не зовут *Internal-ридеры (обход ownership-чека) — это привилегия jobs'],
  ];
  if (!LEGACY_ENV_ALLOW.has(path.basename(f))) {
    rules.push([/process\.env\b/, 'routes не читают process.env — конфиг приходит через deps']);
  }
  forbid(f, rules);
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

// index.js — композиционный корень: сборка, не логика.
{
  const p = path.join(ROOT, 'index.js');
  const n = read(p).split('\n').length;
  const CAP = 300;
  if (n > CAP) errors.push(`server/index.js — ${n} строк > ${CAP}: в композиционный корень снова течёт логика, выноси в services/jobs/infrastructure`);
}

if (errors.length) {
  console.error('[boundaries] нарушения архитектурных границ:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('[boundaries] ok');
