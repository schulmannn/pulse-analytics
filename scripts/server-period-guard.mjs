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
// Ловятся ОПРЕДЕЛЕНИЯ (function NAME( / const|let|var NAME =), а не вызовы: fmtDay(now, 'local')
// и `const { fmtDay } = require('../domain/period')` законны. Комментарии вырезаются тем же
// maskComments, что у фронтового гейта единообразия, поэтому пояснение «зовём fmtDay домена» не
// нарушение. Переименованная копия (dayOf, isCalendarDay) по имени не ловится — это известный
// предел регэкспового гварда; такие копии закрываются ревью и PR 2.4.
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
const DEFINITION_RE = new RegExp(
  `\\bfunction\\s*\\*?\\s*(${NAME})\\s*\\(|\\b(?:const|let|var)\\s+(${NAME})\\s*=(?!=)`,
  'g',
);

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
  const out = [];
  for (const m of text.matchAll(DEFINITION_RE)) {
    out.push({ name: m[1] || m[2], line: text.slice(0, m.index).split('\n').length });
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
