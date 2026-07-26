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
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /X-Session-(?:Token|Refresh)/, file);
    assert.doesNotMatch(source, /(?:get|set|clear)SessionToken/, file);
  }
});

test('server and legacy shell have exactly one narrow X-Session-Token consumer each', () => {
  const authService = read('server/services/authService.js');
  assert.equal(
    (authService.match(/req\.headers\['x-session-token'\]/g) || []).length,
    1,
  );

  const legacy = read('public/index.html');
  assert.equal(
    (legacy.match(/'X-Session-Token': token/g) || []).length,
    1,
  );
  assert.match(legacy, /fetch\('\/api\/auth\/migrate-cookie'/);
});
