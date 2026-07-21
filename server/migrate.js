'use strict';

require('dotenv').config({ quiet: true });
const { loadConfig, validateConfig, ConfigError } = require('./config');
const { createDatabase } = require('./db');
let db = null;

(async () => {
  const config = loadConfig();
  const configErrors = validateConfig(config);
  if (configErrors.length && config.isProduction) {
    throw new ConfigError(configErrors);
  }
  for (const error of configErrors) {
    console.warn(`[migrate:dev] config: ${error.field}: ${error.message}`);
  }
  db = createDatabase(config);
  if (!db.enabled) {
    console.log('[db] DATABASE_URL is not set; migrations skipped');
    return;
  }
  await db.migrate();
})().catch(error => {
  console.error('[db] migration failed:', error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (db) await db.close().catch(() => {});
});
