'use strict';

const { loadConfig } = require('../server/config');
const { createDatabase } = require('../server/db');

function createTestDatabase(databaseUrl = '', env = process.env) {
  return createDatabase(
    loadConfig({
      ...env,
      DATABASE_URL: databaseUrl,
      PGSSL: env.PGSSL || 'disable',
    }),
  );
}

module.exports = { createTestDatabase };
