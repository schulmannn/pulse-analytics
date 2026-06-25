'use strict';

require('dotenv').config();
const db = require('./db');

(async () => {
  if (!db.enabled) {
    console.log('[db] DATABASE_URL is not set; migrations skipped');
    return;
  }
  await db.migrate();
})().catch(error => {
  console.error('[db] migration failed:', error.message);
  process.exitCode = 1;
}).finally(async () => {
  await db.close().catch(() => {});
});
