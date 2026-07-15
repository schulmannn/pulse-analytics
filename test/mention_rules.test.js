'use strict';

// Юнит-тесты чистой валидации правил упоминаний (server/lib/mentionRules). DB-less, синхронно.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRules } = require('../server/lib/mentionRules');

test('validateRules: трим, case-дедуп и сохранение диакритических поисковых вариантов', () => {
  const r = validateRules({
    include_terms: ['  My  Brand ', 'notem', 'Notem', 'nōtem'],
    exclude_terms: ['spam', 'spam'],
    exclude_sources: ['@ByNotem', 'ByNotem', '12345'],
    match_mode: 'word',
  });
  assert.deepEqual(r.include_terms, ['My Brand', 'notem', 'nōtem']);
  assert.deepEqual(r.exclude_terms, ['spam']);
  assert.deepEqual(r.exclude_sources, ['bynotem', '12345']);
  assert.equal(r.match_mode, 'word');
});

test('validateRules: match_mode по умолчанию contains', () => {
  assert.equal(validateRules({ include_terms: ['x'] }).match_mode, 'contains');
});

test('validateRules: include обязателен (1..12)', () => {
  assert.throws(() => validateRules({ include_terms: [] }), /хотя бы один/);
  assert.throws(() => validateRules({ include_terms: ['   '] }), /хотя бы один/);
  assert.throws(() => validateRules({}), /хотя бы один/);
  const many = Array.from({ length: 13 }, (_, i) => `t${i}`);
  assert.throws(() => validateRules({ include_terms: many }), /не больше 12/);
});

test('validateRules: списки — только массивы', () => {
  assert.throws(() => validateRules({ include_terms: 'notem' }), /должно быть списком/);
  assert.throws(() => validateRules({ include_terms: ['x'], exclude_terms: 'y' }), /должно быть списком/);
  assert.throws(() => validateRules(null), /Ожидались правила/);
  assert.throws(() => validateRules(['x']), /Ожидались правила/);
});

test('validateRules: элементы — строки, длина ≤80', () => {
  assert.throws(() => validateRules({ include_terms: [123] }), /должны быть строками/);
  assert.throws(() => validateRules({ include_terms: ['a'.repeat(81)] }), /длиннее 80/);
});

test('validateRules: match_mode вне набора → 400', () => {
  assert.throws(() => validateRules({ include_terms: ['x'], match_mode: 'regex' }), /режим совпадения/);
});

test('validateRules: источник — @username или числовой id, иначе 400', () => {
  assert.throws(() => validateRules({ include_terms: ['x'], exclude_sources: ['bad name!'] }),
    /@username или числовым id/);
  const r = validateRules({ include_terms: ['x'], exclude_sources: ['@Good_Name', '999'] });
  assert.deepEqual(r.exclude_sources, ['good_name', '999']);
});

test('validateRules: лимиты exclude ≤30, sources ≤50', () => {
  const ex = Array.from({ length: 31 }, (_, i) => `e${i}`);
  assert.throws(() => validateRules({ include_terms: ['x'], exclude_terms: ex }), /не больше 30/);
  const src = Array.from({ length: 51 }, (_, i) => `s${i}`);
  assert.throws(() => validateRules({ include_terms: ['x'], exclude_sources: src }), /больше 50/);
});

test('validateRules: ошибка несёт стабильный code/status и не эхает ввод', () => {
  try {
    validateRules({ include_terms: ['x'], match_mode: 'nope-secret' });
    assert.fail('должно бросить');
  } catch (e) {
    assert.equal(e.code, 'mention_rules_invalid');
    assert.equal(e.status, 400);
    assert.ok(!/nope-secret/.test(e.message));
  }
});
