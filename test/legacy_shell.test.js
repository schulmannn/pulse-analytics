'use strict';

// Юнит-тесты чистых функций легаси-шелла (public/index.html), извлечённых через vm — покрытие,
// которого просил триаж для b955cf4 (7-в-1 легаси-батч, e2e-сети нет). Гардим два correctness-фикса:
//   • fmt.short: 999 999 давал «1000k» → теперь «1M» (порог 999950).
//   • dayKeyToTs: 'DD.MM' без года на стыке лет давал будущие даты (декабрь → новый год,
//     сортировался ПОСЛЕ января). Инвариант: результат никогда не >1 дня в будущем.
// Извлекаем ровно нужные функции (не весь скрипт — он тянет DOM), eval'им в изолированном vm.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);

// dayKeyToTs — top-level function; берём до первой закрывающей `}` в колонке 0.
const dayKeyToTs = html.match(/function dayKeyToTs\(day\)[\s\S]*?\n\}/);
assert.ok(dayKeyToTs, 'не удалось извлечь dayKeyToTs из public/index.html');
vm.runInContext(dayKeyToTs[0], sandbox);

// fmt.short — метод объекта; оборачиваем тело в отдельную функцию.
const shortBody = html.match(/short\(n\) \{([\s\S]*?)\n {2}\},/);
assert.ok(shortBody, 'не удалось извлечь fmt.short из public/index.html');
vm.runInContext(`function fmtShort(n) {${shortBody[1]}\n}`, sandbox);

test('fmt.short: 999 999 → «1M», а не «1000k» (b955cf4)', () => {
  assert.strictEqual(sandbox.fmtShort(999999), '1M');    // раньше «1000k»
  assert.strictEqual(sandbox.fmtShort(1000000), '1M');
  assert.strictEqual(sandbox.fmtShort(1500000), '1.5M');
  assert.strictEqual(sandbox.fmtShort(999949), '999.9k'); // на волосок ниже порога M
  assert.strictEqual(sandbox.fmtShort(1000), '1k');
  assert.strictEqual(sandbox.fmtShort(1500), '1.5k');
  assert.strictEqual(sandbox.fmtShort(500), '500');
  assert.strictEqual(sandbox.fmtShort(null), '—');
  assert.strictEqual(sandbox.fmtShort(NaN), '—');
});

test('dayKeyToTs: DD.MM никогда не даёт дату >1 дня в будущем (год-стык) (b955cf4)', () => {
  const now = Date.now();
  // Инвариант по всем месяцам: ни один DD.MM не уезжает в будущее.
  for (let mo = 1; mo <= 12; mo++) {
    const ts = sandbox.dayKeyToTs(`15.${String(mo).padStart(2, '0')}`);
    assert.ok(ts <= now + 86400000, `месяц ${mo}: ${new Date(ts).toISOString()} не должен быть в будущем`);
  }
  // Конкретный wrap: «послезавтра» (>1 дня вперёд) → интерпретируется как прошлый год → в прошлом.
  const d2 = new Date(now + 2 * 86400000);
  const ddmm = `${String(d2.getDate()).padStart(2, '0')}.${String(d2.getMonth() + 1).padStart(2, '0')}`;
  assert.ok(sandbox.dayKeyToTs(ddmm) < now, `${ddmm} (послезавтра) должно уйти в прошлое, а не в будущее`);
});
