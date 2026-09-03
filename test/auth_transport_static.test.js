'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('browser API surfaces never reintroduce bearer auth outside the migration helper', () => {
  for (const file of [
    'frontend/src/api/client.ts',
    'frontend/src/api/queries.ts',
    'frontend/src/lib/aiStream.ts',
    'frontend/src/components/settings/DataSection.tsx',
    'frontend/src/main.tsx',
    'frontend/src/lib/session.ts',
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /X-Session-(?:Token|Refresh)/, file);
    assert.doesNotMatch(source, /(?:get|set|clear)SessionToken/, file);
  }
});

test('заголовочного транспорта сессии в сервере не осталось НИ ОДНОГО потребителя', () => {
  /* Тест ИНВЕРТИРОВАН. Раньше он требовал ровно одного потребителя X-Session-Token — так
     охранялся одноразовый мост до-cookie-сессии. Критерий удаления моста («семь дней после
     первого деплоя») наступил в июле, а сам он прожил до сентября (аудит #554). Теперь
     потребителей обязано быть НОЛЬ: сессия приходит только HttpOnly-cookie, и любой новый
     заголовочный путь — это регресс, а не мост. */
  for (const file of [
    'server/services/authService.js',
    'server/routes/auth.js',
    'server/lib/auth.js',
    'server/app.js',
    'server/composition.js',
  ]) {
    assert.doesNotMatch(read(file), /req\.headers\['x-session-token'\]/i, file);
    assert.doesNotMatch(read(file), /migrate-cookie/, file);
  }
});

test('nonce-оболочки и её CSP-контура больше нет', () => {
  // Второй контур заголовков существовал только ради public/index.html: у SPA инлайновых
  // скриптов нет, и nonce ей не нужен.
  assert.equal(fs.existsSync(path.join(root, 'public/index.html')), false, 'public/index.html удалён');
  assert.doesNotMatch(read('server/lib/securityHeaders.js'), /legacyCspHeader/);
  assert.doesNotMatch(read('server/app.js'), /legacyCspHeader|app\.get\('\/legacy'/);
});
