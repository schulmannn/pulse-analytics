'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const databaseModule = require('../server/db');
const { loadConfig } = require('../server/config');

test('db module exports a factory instead of a module-load singleton', () => {
  assert.equal(typeof databaseModule.createDatabase, 'function');
  assert.equal(typeof databaseModule.isDbUnavailable, 'function');
  assert.equal(databaseModule.enabled, undefined);
});

test('createDatabase returns independent facades from independent configs', async () => {
  const first = databaseModule.createDatabase(loadConfig({}));
  const second = databaseModule.createDatabase(loadConfig({}));

  assert.notEqual(first, second);
  assert.equal(first.enabled, false);
  assert.equal(second.enabled, false);
  assert.notEqual(first.runJobOnce, second.runJobOnce);
  await first.close();
  await second.close();
});
