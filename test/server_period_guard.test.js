'use strict';

// Гвард примитивов периода (scripts/server-period-guard.mjs, часть check:boundaries с PR 2.5):
// jobs/lib — ноль своих определений, routes — трещотка по файлу и имени, domain — законный дом.
// Проверяем, что ловятся именно ОПРЕДЕЛЕНИЯ: вызов, импорт из домена и упоминание в комментарии
// гвард пропускает; исчезнувшая запись baseline проходит с подсказкой, рост — ошибка.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const guard = () => import('../scripts/server-period-guard.mjs');
const ROOT = path.join(__dirname, '..');

test('jobs/lib: посаженное определение валит гвард — function, const, let, parse…Period', async () => {
  const { checkPeriodGuard } = await guard();
  const planted = [
    { rel: 'server/jobs/newJob.js', src: "'use strict';\nconst fmtDay = (d) => d.toISOString().slice(0, 10);\n" },
    { rel: 'server/jobs/nested/deep.js', src: 'function isDayKey(v) {\n  return /^\\d{4}-\\d{2}-\\d{2}$/.test(v);\n}\n' },
    { rel: 'server/lib/util.js', src: 'let shiftDayKey = null;\nasync function parseFooPeriod(req) {}\nvar previousWindow = () => null;\n' },
  ];
  const { errors } = checkPeriodGuard(planted, {});
  assert.deepEqual(
    errors.map((e) => {
      const [where, why] = e.split(' — ');
      return `${where} ${why.split(' ')[0]}`;
    }),
    [
      'server/jobs/newJob.js:2 fmtDay',
      'server/jobs/nested/deep.js:1 isDayKey',
      'server/lib/util.js:1 shiftDayKey',
      'server/lib/util.js:2 parseFooPeriod',
      'server/lib/util.js:3 previousWindow',
    ],
  );
});

test('jobs/lib: вызов, импорт из домена, ключ экспорта и комментарий — не определения', async () => {
  const { checkPeriodGuard, periodDefinitions } = await guard();
  const src = [
    "const { fmtDay, isDayKey, shiftDay } = require('../domain/period');",
    'const period = require("../domain/period");',
    '// раньше здесь была const fmtDay = (d) => … — теперь fmtDay(d, \'local\') домена',
    '/* function isDayKey(v) { return true; } */',
    "const today = fmtDay(new Date(), 'local');",
    'const ok = isDayKey(today) && period.previousWindow(today, today);',
    'if (fmtDay == null) throw new Error();',
    'module.exports = { previousWindow: previousMsWindow, parseDayish: 1 };',
    'const isDayKeyStrict = 1; const myFmtDay = 2;',
  ].join('\n');
  assert.deepEqual(periodDefinitions(src), []);
  const { errors, hints } = checkPeriodGuard([{ rel: 'server/jobs/x.js', src }], {});
  assert.deepEqual(errors, []);
  assert.deepEqual(hints, []);
});

// Ревью 2.5a: гвард ловил только `function NAME(` и `const NAME =`. Копия методом объекта/класса,
// стрелкой в свойстве или через exports.NAME проходила, а законный алиас из домена
// (`const fmtDay = require('../domain/period').fmtDay`) валил check.
test('jobs/lib: копия методом, свойством-функцией и через exports тоже определение', async () => {
  const { periodDefinitions } = await guard();
  const src = [
    'const h = {',
    '  fmtDay(d) { return d; },',
    '  isDayKey: (v) => true,',
    '  shiftDay: function (k, o) { return k; },',
    '  async parseXPeriod(req) {},',
    '};',
    'class A {',
    '  static shiftDayKey(k, o) {',
    '    return k;',
    '  }',
    '  daysBetween(a, b) {}',
    '}',
    'exports.rangeDays = (a, b) => 1;',
    'module.exports.previousWindow = function () {};',
    'const g = { parseDay: async (s) => s, daysBetween: x => x };',
  ].join('\n');
  assert.deepEqual(
    periodDefinitions(src).map((d) => `${d.line}:${d.name}`),
    [
      '2:fmtDay',
      '3:isDayKey',
      '4:shiftDay',
      '5:parseXPeriod',
      '8:shiftDayKey',
      '11:daysBetween',
      '13:rangeDays',
      '14:previousWindow',
      '15:parseDay',
      '15:daysBetween',
    ],
  );
});

test('jobs/lib: алиас экспорта домена — не копия; вызовы, тернарник и ключ-ссылка тоже не определения', async () => {
  const { periodDefinitions } = await guard();
  const src = [
    "const period = require('../domain/period');",
    "const fmtDay = require('../domain/period').fmtDay;",
    'const isDayKey = period.isDayKey;',
    "const parseCdekPeriod = require('../domain/cdekPeriod').parseCdekPeriod;",
    'exports.shiftDay = period.shiftDay;',
    'const pick = flag ? isDayKey : (v) => false;',
    'const api = { previousWindow: previousMsWindow, fmtDay };',
    'if (isDayKey(k)) {',
    '}',
    'while (fmtDay(new Date()) === k) {}',
  ].join('\n');
  assert.deepEqual(periodDefinitions(src), []);
  // Алиас не из домена — по-прежнему копия (чужой модуль мог завести свой примитив).
  assert.deepEqual(
    periodDefinitions("const helpers = require('./helpers');\nconst fmtDay = helpers.fmtDay;\nconst isDayKey = require('./x').isDayKey;\n")
      .map((d) => d.name),
    ['fmtDay', 'isDayKey'],
  );
});

test('domain — законный дом: определения там гвард не проверяет', async () => {
  const { checkPeriodGuard } = await guard();
  const { errors } = checkPeriodGuard([{ rel: 'server/domain/period.js', src: 'function fmtDay(at, tz) {}\n' }], {});
  assert.deepEqual(errors, []);
});

test('routes: определения в пределах baseline проходят, ужатие — проходит с подсказкой', async () => {
  const { checkPeriodGuard } = await guard();
  const baseline = { 'server/routes/a.js': ['fmtDay', 'isDayKey', 'parseAPeriod'], 'server/routes/gone.js': ['isDayKey'] };
  const same = checkPeriodGuard(
    [{ rel: 'server/routes/a.js', src: 'const fmtDay = 1;\nconst isDayKey = 2;\nfunction parseAPeriod(req) {}\n' }],
    baseline,
  );
  assert.deepEqual(same.errors, []);
  assert.deepEqual(same.hints, ['server/routes/gone.js — файла нет, уберите его из ROUTES_PERIOD_BASELINE']);

  // PR 2.1–2.3 убрали копии: гвард зелёный и подсказывает ужать baseline.
  const shrunk = checkPeriodGuard(
    [{ rel: 'server/routes/a.js', src: "const { parsePeriod } = require('../domain/period');\nconst isDayKey = 2;\n" }],
    baseline,
  );
  assert.deepEqual(shrunk.errors, []);
  assert.deepEqual(shrunk.hints, [
    'server/routes/a.js — fmtDay: 1 → 0, ужмите ROUTES_PERIOD_BASELINE',
    'server/routes/a.js — parseAPeriod: 1 → 0, ужмите ROUTES_PERIOD_BASELINE',
    'server/routes/gone.js — файла нет, уберите его из ROUTES_PERIOD_BASELINE',
  ]);
});

test('routes: рост валит — вторая копия, новое имя в файле из baseline, новый файл с копией', async () => {
  const { checkPeriodGuard } = await guard();
  const baseline = { 'server/routes/a.js': ['isDayKey'] };
  const { errors } = checkPeriodGuard(
    [
      { rel: 'server/routes/a.js', src: 'const isDayKey = 1;\nfunction x() {\n  const isDayKey = 2;\n}\nconst rangeDays = 3;\n' },
      { rel: 'server/routes/b.js', src: 'function parseBPeriod(req) {}\n' },
    ],
    baseline,
  );
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.match(errors[0], /^server\/routes\/a\.js:1, 3 — новая копия isDayKey в роуте \(было 1, стало 2\)/);
  assert.match(errors[1], /^server\/routes\/a\.js:5 — новая копия rangeDays в роуте \(было 0, стало 1\)/);
  assert.match(errors[2], /^server\/routes\/b\.js:1 — новая копия parseBPeriod в роуте \(было 0, стало 1\)/);
});

test('дерево репо: jobs/lib без копий, роуты не выше baseline', async () => {
  const { checkPeriodGuard, collectPeriodFiles, ROUTES_PERIOD_BASELINE } = await guard();
  const files = collectPeriodFiles(ROOT);
  assert.ok(files.some((f) => f.rel === 'server/jobs/msBackfillJob.js'), 'jobs в обходе');
  assert.ok(files.some((f) => f.rel === 'server/lib/msTopProducts.js'), 'lib в обходе');
  assert.ok(!files.some((f) => f.rel.startsWith('server/domain/')), 'domain не проверяется');
  const { errors } = checkPeriodGuard(files, ROUTES_PERIOD_BASELINE);
  assert.deepEqual(errors, []);
});
