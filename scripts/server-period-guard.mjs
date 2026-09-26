// Гвард примитивов периода на сервере (PR 2.5, U01). Часть scripts/check-server-boundaries.mjs;
// вынесен в модуль, чтобы правила можно было проверить юнит-тестом (test/server_period_guard.test.js).
//
// Окно периода на сервере определяется в ОДНОМ месте — server/domain/period.js (isDayKey, fmtDay,
// shiftDay, daysBetween, previousWindow, parsePeriod). Копии расходились: формат без календаря,
// «сегодня» в разных зонах, прошлое окно на день короче. Гвард запрещает ОПРЕДЕЛЯТЬ эти примитивы
// заново; вызывать их из домена можно везде.
//   • server/jobs/**, server/lib/** — ноль определений, без baseline;
//   • server/routes/** — трещотка по файлу и имени (ROUTES_PERIOD_BASELINE): копии роутов убирают
//     PR 2.1–2.4, до тех пор новая копия или новый файл с копией — ошибка, а исчезнувшая запись
//     baseline проходит с подсказкой ужать его;
//   • server/domain/** — законный дом примитивов, не проверяется.
//
// Ловятся ОПРЕДЕЛЕНИЯ, а не вызовы: `function NAME(`, `const|let|var NAME =`, `(module.)exports.NAME =`,
// метод объекта или класса `NAME(…) {` и свойство-функция `NAME: (…) =>` / `NAME: function`.
// Законны вызов fmtDay(now, 'local'), деструктуризация `const { fmtDay } = require('../domain/period')`
// и алиас экспорта домена — `const fmtDay = require('../domain/…').fmtDay` или `period.fmtDay`, где
// `period` привязан к require модуля server/domain/. Комментарии вырезаются тем же maskComments, что
// у фронтового гейта единообразия, поэтому пояснение «зовём fmtDay домена» не нарушение.
// Пределы регэкспового гварда (закрываются ревью): переименованная копия (dayOf, isCalendarDay —
// последнюю убирает PR 2.4) по имени не ловится; строковый литерал, дословно похожий на определение,
// считается определением; метод с вложенными скобками в параметрах (`fmtDay(d = f()) {`) не ловится.
// Каталоги вне jobs/lib/routes (services/, repos/, infrastructure/, server/*.js) гвард не смотрит:
// так задан объём PR 2.5 — расширение отдельным решением, когда параллельные PR 2.x сольются.
import fs from 'node:fs';
import path from 'node:path';
import { maskComments } from '../frontend/scripts/consistency-lint.mjs';

/** Имена примитивов периода; плюс любой локальный разборщик окна parse…Period. */
export const PERIOD_PRIMITIVES = [
  'isDayKey',
  'fmtDay',
  'previousWindow',
  'parseDay',
  'shiftDay',
  'shiftDayKey',
  'daysBetween',
  'inclusiveDayLength',
  'rangeDays',
];
const NAME = `(?:${PERIOD_PRIMITIVES.join('|')}|parse[A-Za-z0-9_$]*Period)`;
// Формы определения; у каждой ровно одна группа захвата имени. Присваивание (const/let/var и exports)
// идёт с флагом ASSIGN — только его правая часть может оказаться алиасом экспорта домена.
const FORMS = [
  { re: `\\bfunction\\s*\\*?\\s*(${NAME})\\s*\\(` },
  { re: `\\b(?:const|let|var)\\s+(${NAME})\\s*=(?!=)`, assign: true },
  { re: `(?<![\\w$.])(?:module\\s*\\.\\s*)?exports\\s*\\.\\s*(${NAME})\\s*=(?!=)`, assign: true },
  // Метод объекта/класса: имя в начале строки или после { } , ; (плюс static/async/get/set/*).
  {
    re: `(?<=(?:^|[{},;])[ \\t]*(?:(?:static|async|get|set)\\s+|\\*\\s*)*)(${NAME})[ \\t]*\\([^)]*\\)[ \\t]*\\{`,
  },
  // Свойство-функция: ключ после { или , (не тернарник `? isDayKey :`), значение — function или стрелка.
  {
    re: `(?<=[{,]\\s*)(${NAME})\\s*:\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`,
  },
];
const DEFINITION_RE = new RegExp(FORMS.map((f) => f.re).join('|'), 'gm');
const ASSIGN_GROUPS = FORMS.map((f, i) => (f.assign ? i + 1 : 0)).filter(Boolean);

// Без групп захвата: вставляется в другие выражения и не должна сдвигать их номера групп.
const DOMAIN_REQUIRE = `require\\(\\s*(?:'[^'\\n]*\\bdomain/[^'\\n]*'|"[^"\\n]*\\bdomain/[^"\\n]*")\\s*\\)`;
// Идентификаторы, привязанные к модулю домена: `const period = require('../domain/period')`.
const DOMAIN_BINDING_RE = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${DOMAIN_REQUIRE}`, 'g');

/** Правая часть присваивания — чистый алиас экспорта домена с тем же именем (`… = period.fmtDay;`). */
function isDomainAlias(text, rhsFrom, name, bindings) {
  const head = bindings.length ? `(?:${DOMAIN_REQUIRE}|(?:${bindings.join('|')})\\b)` : DOMAIN_REQUIRE;
  return new RegExp(`^\\s*${head}\\s*\\.\\s*${name}\\s*(?:[;,)\\n]|$)`).test(text.slice(rhsFrom, rhsFrom + 300));
}

/** Каталоги без права на свои примитивы периода — ноль определений. */
export const ZERO_SCOPES = ['server/jobs/', 'server/lib/'];
/** Каталог с трещоткой: копии уходят PR 2.1–2.4. */
export const RATCHET_SCOPE = 'server/routes/';

/**
 * Определения примитивов в роутах на момент PR 2.5 — только ужимается. Запись — имена по файлу
 * (повтор имени = два определения). Убрали копию — удалите имя отсюда (подсказку печатает гвард).
 */
export const ROUTES_PERIOD_BASELINE = {
  'server/routes/metrika.js': ['fmtDay', 'isDayKey', 'rangeDays', 'parseYmPeriod'],
  'server/routes/moysklad.js': ['fmtDay', 'isDayKey', 'parseMsPeriod'],
  'server/routes/rusender.js': ['isDayKey', 'rangeDays'],
};

/** Определения примитивов периода в исходнике: [{ name, line }]. Комментарии не считаются. */
export function periodDefinitions(src) {
  const text = maskComments(src);
  const bindings = [...text.matchAll(DOMAIN_BINDING_RE)].map((m) => m[1].replace(/\$/g, '\\$'));
  const out = [];
  for (const m of text.matchAll(DEFINITION_RE)) {
    const group = m.findIndex((g, i) => i > 0 && g !== undefined);
    const name = m[group];
    // Номер группы = номер формы (по одной группе на форму).
    if (ASSIGN_GROUPS.includes(group) && isDomainAlias(text, m.index + m[0].length, name, bindings)) continue;
    const at = m.index + m[0].indexOf(name);
    out.push({ name, line: text.slice(0, at).split('\n').length });
  }
  return out;
}

const countBy = (names) => {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  return counts;
};

/**
 * Сверка. `files` — [{ rel: 'server/jobs/x.js', src }], пути от корня репо через '/'.
 * Возвращает { errors, hints }: errors валят check, hints — подсказка ужать baseline.
 */
export function checkPeriodGuard(files, baseline = ROUTES_PERIOD_BASELINE) {
  const errors = [];
  const hints = [];
  const seen = new Set();
  for (const { rel, src } of files) {
    const defs = periodDefinitions(src);
    if (ZERO_SCOPES.some((scope) => rel.startsWith(scope))) {
      for (const d of defs) {
        errors.push(
          `${rel}:${d.line} — ${d.name} определяется заново: примитивы периода живут в server/domain/period.js, зовите их оттуда`,
        );
      }
      continue;
    }
    if (!rel.startsWith(RATCHET_SCOPE)) continue;
    seen.add(rel);
    const allowed = countBy(baseline[rel] || []);
    const actual = countBy(defs.map((d) => d.name));
    for (const [name, n] of actual) {
      const cap = allowed.get(name) || 0;
      if (n > cap) {
        const lines = defs.filter((d) => d.name === name).map((d) => d.line).join(', ');
        errors.push(
          `${rel}:${lines} — новая копия ${name} в роуте (было ${cap}, стало ${n}): берите разбор окна из server/domain/period.js`,
        );
      }
    }
    for (const [name, cap] of allowed) {
      const n = actual.get(name) || 0;
      if (n < cap) hints.push(`${rel} — ${name}: ${cap} → ${n}, ужмите ROUTES_PERIOD_BASELINE`);
    }
  }
  for (const rel of Object.keys(baseline)) {
    if (!seen.has(rel)) hints.push(`${rel} — файла нет, уберите его из ROUTES_PERIOD_BASELINE`);
  }
  return { errors, hints };
}

const listJsRecursive = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsRecursive(target);
        return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
      })
    : [];

/** Файлы под гвардом из дерева репо `repoRoot` в форме для checkPeriodGuard. */
export function collectPeriodFiles(repoRoot) {
  return ['jobs', 'lib', 'routes'].flatMap((dir) =>
    listJsRecursive(path.join(repoRoot, 'server', dir)).map((file) => ({
      rel: path.relative(repoRoot, file).split(path.sep).join('/'),
      src: fs.readFileSync(file, 'utf8'),
    })),
  );
}
