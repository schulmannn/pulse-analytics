'use strict';

// Проверка реестра закрытия (scripts/check-consistency-ledger.mjs): боевой файл согласован, а
// каждое правило валидатора ловит свою порчу. Иначе ослабленный валидатор молча пропустил бы
// потерянный id или закрытие не тем PR — и это всплыло бы только на сверке 8.3.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let validateLedger;
let canonicalIds;
let summarize;

test.before(async () => {
  ({ validateLedger, canonicalIds, summarize } = await import('../scripts/check-consistency-ledger.mjs'));
});

const real = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'consistency-ledger.json'), 'utf8'));

test('боевой реестр согласован: 141 id, у каждого один закрывающий PR', () => {
  const ledger = real();
  assert.deepEqual(validateLedger(ledger), []);
  assert.equal(canonicalIds().length, 141);
  assert.deepEqual(Object.keys(ledger.ids).sort(), canonicalIds().sort());
  assert.equal(summarize(ledger).deferred, 1);
});

test('потерянный и неизвестный id', () => {
  const ledger = real();
  delete ledger.ids['API-17'];
  ledger.ids['API-18'] = { area: 'api', title: 'лишний', closes_in: '2.7', closed_by: null, partially: [] };
  const errors = validateLedger(ledger);
  assert.ok(errors.some((e) => e.startsWith('API-17: нет в реестре')), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('API-18: неизвестный id')), errors.join('\n'));
});

test('closes_in — ровно один существующий PR плана', () => {
  const ledger = real();
  ledger.ids['EXPAND-1'].closes_in = ['7.2', '7.3'];
  ledger.ids['EXPAND-3'].closes_in = '9.9';
  const errors = validateLedger(ledger);
  assert.ok(errors.some((e) => e.startsWith('EXPAND-1: closes_in обязан быть одной строкой')), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('EXPAND-3: closes_in «9.9»')), errors.join('\n'));
});

test('перенос на mobile-этап требует пояснения', () => {
  const ledger = real();
  delete ledger.ids['SHELL-19'].note;
  assert.ok(validateLedger(ledger).some((e) => e.startsWith('SHELL-19: перенос')));
});

test('closed_by согласован с plan_prs в обе стороны', () => {
  // Смержили 1.6 как #650: оба его id обязаны получить closed_by.
  const merged = real();
  merged.plan_prs['1.6'] = 650;
  merged.ids['EXPAND-17'].closed_by = 650;
  merged.ids['PERIOD-15'].partially = ['1.3 #646', '1.6 #650'];
  merged.ids['CARDS-17'].partially = ['1.6 #650'];
  merged.ids['STATES-14'].partially = ['1.6 #650'];
  merged.ids['SHELL-12'].partially = ['1.6 #650'];
  const errors = validateLedger(merged);
  assert.deepEqual(errors, ['CHARTS-22: 1.6 смержен как #650, а closed_by пуст — реестр отстал']);

  merged.ids['CHARTS-22'].closed_by = 651;
  assert.deepEqual(validateLedger(merged), ['CHARTS-22: closed_by #651, а plan_prs[1.6] = #650']);

  const unmerged = real();
  unmerged.ids['API-1'].closed_by = 700;
  assert.ok(validateLedger(unmerged).some((e) => e.startsWith('API-1: closed_by #700, а plan_prs[2.7] = null')));
});

test('partially — PR плана с номером ровно тогда, когда он известен', () => {
  const ledger = real();
  ledger.ids['API-1'].partially = ['1.1'];
  ledger.ids['API-2'].partially = ['1.2 #999'];
  ledger.ids['API-17'].partially = ['2.5'];
  const errors = validateLedger(ledger);
  assert.ok(errors.includes('API-1: partially «1.1» без номера, хотя он смержен как #644'), errors.join('\n'));
  assert.ok(errors.includes('API-2: partially «1.2 #999», а plan_prs[1.2] = #645'), errors.join('\n'));
  assert.ok(errors.includes('API-17: 2.5 и закрывает, и частично — выберите одно'), errors.join('\n'));
});
