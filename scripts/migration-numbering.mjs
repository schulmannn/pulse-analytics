const migrationPattern = /^(\d{3})_([^/]+)\.sql$/;
const allowedDuplicates = new Map([
  ['013', new Set(['013_crash_signatures.sql', '013_ig_followers_total.sql'])],
]);

export function validateMigrationFiles(files) {
  const byNumber = new Map();
  const errors = [];

  for (const file of files) {
    const match = file.match(migrationPattern);
    if (!match) {
      errors.push(`${file}: expected NNN_description.sql`);
      continue;
    }
    const number = match[1];
    const group = byNumber.get(number) ?? [];
    group.push(file);
    byNumber.set(number, group);
  }

  for (const [number, group] of byNumber) {
    if (group.length === 1) continue;
    const allowed = allowedDuplicates.get(number);
    const exactGrandfatheredSet = allowed
      && group.length === allowed.size
      && group.every((file) => allowed.has(file));
    if (!exactGrandfatheredSet) {
      errors.push(`migration number ${number} is used by: ${group.join(', ')}`);
    }
  }

  return errors;
}
