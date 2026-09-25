#!/usr/bin/env node
// Реестр закрытия программы унификации источников — проверка формы (PR 1.7).
//
// scripts/consistency-ledger.json держит для каждого из 141 расхождения ровно один закрывающий PR
// плана (closes_in) и номер смерженного PR на GitHub (closed_by). Описание каждого PR программы
// несёт строки «Закрывает: ID, …» и «Частично: ID, …»; сверку реестра с описаниями смерженных PR
// делает 8.3 — здесь GitHub не спрашивается. Здесь — то, что можно проверить по самому файлу:
//   • ровно 141 id и ни одного лишнего (канонический набор — AREAS ниже, нумерация сплошная);
//   • у каждого id один closes_in: PR плана из plan_prs или отложенный этап с пояснением;
//   • closed_by согласован с plan_prs в обе стороны: номер стоит ⇔ закрывающий PR смержен;
//   • partially — PR плана, аннотированные номером ровно тогда, когда он известен.
//
//   node scripts/check-consistency-ledger.mjs   → exit 1 при любой несогласованности
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Канонический набор: префикс id → число расхождений области (аудит программы, 141 в сумме). */
export const AREAS = {
  EXPAND: 18,
  SHELL: 20,
  CHARTS: 23,
  PERIOD: 15,
  STATES: 14,
  CARDS: 18,
  TABLES: 16,
  API: 17,
};

/** Этапы вне нумерованных PR плана: id туда переносится только с пояснением (note). */
export const DEFERRED = new Set(['mobile-stage']);

const PLAN_PR = /^\d+\.\d+$/;
const PARTIAL = /^(\d+\.\d+)(?: #(\d+))?$/;
const TOP_KEYS = new Set(['$comment', 'plan_prs', 'ids']);
const ID_KEYS = new Set(['area', 'title', 'closes_in', 'closed_by', 'partially', 'note']);

const isGhNumber = (v) => Number.isInteger(v) && v > 0;

export function canonicalIds() {
  return Object.entries(AREAS).flatMap(([prefix, n]) => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`));
}

export function validateLedger(ledger) {
  const errors = [];
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return ['реестр — не объект'];
  for (const key of Object.keys(ledger)) {
    if (!TOP_KEYS.has(key)) errors.push(`неизвестный ключ верхнего уровня «${key}»`);
  }
  const plan = ledger.plan_prs;
  const ids = ledger.ids;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return [...errors, 'нет объекта plan_prs'];
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) return [...errors, 'нет объекта ids'];

  for (const [pr, gh] of Object.entries(plan)) {
    if (!PLAN_PR.test(pr)) errors.push(`plan_prs: «${pr}» — не номер PR плана (N.M)`);
    if (gh !== null && !isGhNumber(gh)) errors.push(`plan_prs: ${pr} → ${JSON.stringify(gh)} — не номер PR на GitHub и не null`);
  }

  const expected = new Set(canonicalIds());
  for (const id of expected) if (!(id in ids)) errors.push(`${id}: нет в реестре`);

  for (const [id, entry] of Object.entries(ids)) {
    if (!expected.has(id)) {
      errors.push(`${id}: неизвестный id — канонический набор задан AREAS`);
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${id}: запись — не объект`);
      continue;
    }
    for (const key of Object.keys(entry)) if (!ID_KEYS.has(key)) errors.push(`${id}: неизвестное поле «${key}»`);
    const area = id.slice(0, id.lastIndexOf('-')).toLowerCase();
    if (entry.area !== area) errors.push(`${id}: area «${entry.area}», ожидалась «${area}»`);
    if (typeof entry.title !== 'string' || !entry.title.trim()) errors.push(`${id}: нет title`);

    // Ровно один закрывающий PR: строка, а не список, и существующая.
    const closes = entry.closes_in;
    const deferred = DEFERRED.has(closes);
    if (typeof closes !== 'string') {
      errors.push(`${id}: closes_in обязан быть одной строкой — у id ровно один закрывающий PR`);
    } else if (!deferred && !(closes in plan)) {
      errors.push(`${id}: closes_in «${closes}» — нет такого PR в plan_prs`);
    }
    if (deferred && (typeof entry.note !== 'string' || !entry.note.trim())) {
      errors.push(`${id}: перенос на «${closes}» без пояснения (note)`);
    }

    // closed_by ⇔ закрывающий PR смержен, и номер тот же.
    const closedBy = entry.closed_by;
    const merged = typeof closes === 'string' && !deferred ? plan[closes] : null;
    if (closedBy !== null && !isGhNumber(closedBy)) {
      errors.push(`${id}: closed_by ${JSON.stringify(closedBy)} — не номер PR и не null`);
    } else if (closedBy !== null && deferred) {
      errors.push(`${id}: отложенный id не может быть закрыт (closed_by ${closedBy})`);
    } else if (closedBy !== null && merged !== closedBy) {
      errors.push(`${id}: closed_by #${closedBy}, а plan_prs[${closes}] = ${merged === null ? 'null' : `#${merged}`}`);
    } else if (closedBy === null && isGhNumber(merged)) {
      errors.push(`${id}: ${closes} смержен как #${merged}, а closed_by пуст — реестр отстал`);
    }

    // Частичные вклады: PR плана, номер — ровно когда известен, закрывающий PR сюда не входит.
    if (!Array.isArray(entry.partially)) {
      errors.push(`${id}: partially обязан быть списком (пустой — [])`);
      continue;
    }
    const seen = new Set();
    for (const item of entry.partially) {
      const m = typeof item === 'string' ? PARTIAL.exec(item) : null;
      if (!m) {
        errors.push(`${id}: partially «${item}» — ожидается «N.M» или «N.M #номер»`);
        continue;
      }
      const [, pr, num] = m;
      if (seen.has(pr)) errors.push(`${id}: partially повторяет ${pr}`);
      seen.add(pr);
      if (!(pr in plan)) errors.push(`${id}: partially «${pr}» — нет такого PR в plan_prs`);
      if (pr === closes) errors.push(`${id}: ${pr} и закрывает, и частично — выберите одно`);
      const known = plan[pr] ?? null;
      if (num !== undefined && Number(num) !== known) {
        errors.push(`${id}: partially «${item}», а plan_prs[${pr}] = ${known === null ? 'null' : `#${known}`}`);
      } else if (num === undefined && known !== null) {
        errors.push(`${id}: partially «${pr}» без номера, хотя он смержен как #${known}`);
      }
    }
  }
  return errors;
}

export function summarize(ledger) {
  const entries = Object.values(ledger.ids);
  return {
    total: entries.length,
    closed: entries.filter((e) => e.closed_by !== null).length,
    deferred: entries.filter((e) => DEFERRED.has(e.closes_in)).length,
  };
}

function main() {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'consistency-ledger.json');
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[check:ledger] scripts/consistency-ledger.json не читается: ${error.message}`);
    process.exit(1);
  }
  const errors = validateLedger(ledger);
  if (errors.length) {
    console.error('[check:ledger] реестр закрытия несогласован:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  const { total, closed, deferred } = summarize(ledger);
  console.log(`[check:ledger] ${total} id: закрыто ${closed}, отложено ${deferred}, в работе ${total - closed - deferred}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
