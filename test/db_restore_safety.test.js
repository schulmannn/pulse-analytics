'use strict';

// Unit tests for the db-restore fail-closed preflight. Pure helper — no DB, no destructive restore.
// The .mjs module is loaded via dynamic import from this CJS test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

let externalReferencers;
test.before(async () => {
  ({ externalReferencers } = await import('../ops/db-restore-safety.mjs'));
});

test('full snapshot (every referencing table included): nothing external is at risk', () => {
  const fkRows = [
    { child: 'ig_daily', parent: 'channels' },
    { child: 'posts', parent: 'channels' },
    { child: 'post_stats', parent: 'posts' },
  ];
  const truncateSet = ['channels', 'ig_daily', 'posts', 'post_stats'];
  assert.deepEqual(externalReferencers(fkRows, truncateSet), []);
});

test('out-of-snapshot child referencing a snapshotted parent is flagged before TRUNCATE', () => {
  const fkRows = [
    { child: 'posts', parent: 'channels' },
    { child: 'new_feature_events', parent: 'channels' }, // added by a later migration, not in snapshot
  ];
  const truncateSet = ['channels', 'posts'];
  assert.deepEqual(externalReferencers(fkRows, truncateSet), ['new_feature_events']);
});

test('multiple external referencers are de-duplicated and sorted', () => {
  const fkRows = [
    { child: 'z_ext', parent: 'channels' },
    { child: 'a_ext', parent: 'posts' },
    { child: 'a_ext', parent: 'channels' }, // same child via a second FK
  ];
  const truncateSet = new Set(['channels', 'posts']);
  assert.deepEqual(externalReferencers(fkRows, truncateSet), ['a_ext', 'z_ext']);
});

test('self-referencing FK inside the snapshot is not treated as external', () => {
  const fkRows = [{ child: 'channels', parent: 'channels' }];
  assert.deepEqual(externalReferencers(fkRows, ['channels']), []);
});

test('an FK entirely outside the truncate set is ignored (parent not truncated)', () => {
  const fkRows = [{ child: 'audit_log', parent: 'unrelated_table' }];
  assert.deepEqual(externalReferencers(fkRows, ['channels', 'posts']), []);
});

test('restore script omits CASCADE so Postgres fails closed for any dependency the preflight misses', () => {
  const source = readFileSync(join(__dirname, '..', 'ops', 'db-restore.mjs'), 'utf8');
  assert.match(source, /client\.query\(`TRUNCATE \$\{quoted\}`\)/);
  assert.doesNotMatch(source, /client\.query\(`TRUNCATE \$\{quoted\} CASCADE`\)/);
  assert.doesNotMatch(source, /skip \$\{t\}: no file in snapshot/,
    'a missing manifest payload must throw and roll back instead of committing an empty table');
});
