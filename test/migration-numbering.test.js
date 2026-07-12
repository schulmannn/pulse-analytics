const test = require('node:test');
const assert = require('node:assert/strict');

let validateMigrationFiles;

test.before(async () => {
  ({ validateMigrationFiles } = await import('../scripts/migration-numbering.mjs'));
});

test('allows unique migration numbers and the exact historical 013 pair', () => {
  const errors = validateMigrationFiles([
    '012_jobs.sql',
    '013_crash_signatures.sql',
    '013_ig_followers_total.sql',
    '014_capacity_rollups.sql',
  ]);
  assert.deepEqual(errors, []);
});

test('rejects another file added to the historical 013 pair', () => {
  const errors = validateMigrationFiles([
    '013_crash_signatures.sql',
    '013_ig_followers_total.sql',
    '013_new_feature.sql',
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /migration number 013/);
});

test('rejects any new duplicate number', () => {
  const errors = validateMigrationFiles(['014_first.sql', '014_second.sql']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /migration number 014/);
});

test('rejects migration filenames outside the numbering convention', () => {
  assert.deepEqual(
    validateMigrationFiles(['15_missing_zero.sql']),
    ['15_missing_zero.sql: expected NNN_description.sql'],
  );
});
