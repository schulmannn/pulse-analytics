'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (name) => readFileSync(join(__dirname, '..', name), 'utf8');

test('all production runtime images explicitly drop root privileges', () => {
  const web = read('Dockerfile.web');
  const mtproto = read('Dockerfile.mtproto');
  const collector = read('Dockerfile.collector');

  assert.match(web, /\nUSER node\s+\nCMD \["npm", "start"\]/);
  assert.match(mtproto, /\nUSER atlavue[\s\S]+CMD \["python3", "mtproto\/service\.py"\]/);
  assert.match(collector, /\nUSER collector[\s\S]+ENTRYPOINT/);
});

test('Dockerfile.web описывает ЕДИНСТВЕННУЮ HTML-поверхность', () => {
  // Комментарий описывал две поверхности — SPA и nonce-оболочку на /legacy. Оболочка удалена
  // (аудит #554, ТЗ-6), и упоминание её в образе теперь было бы враньём.
  const web = read('Dockerfile.web');
  assert.match(web, /ЕДИНСТВЕННАЯ HTML-поверхность/);
  assert.doesNotMatch(web, /\/legacy/);
  assert.doesNotMatch(web, /served by Express under \/app/);
});
