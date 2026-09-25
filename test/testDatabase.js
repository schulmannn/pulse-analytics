'use strict';

const { loadConfig } = require('../server/config');
const { createDatabase } = require('../server/db');
// Ту же фабрику в фасад передаёт composition.js: db.js её больше не требует сам (гвард границ),
// поэтому тестовый стенд обязан собрать её так же, иначе секции gdpr в фасаде не будет.
const { createGdprService } = require('../server/services/gdprService');

function createTestDatabase(databaseUrl = '', env = process.env) {
  return createDatabase(
    loadConfig({
      ...env,
      DATABASE_URL: databaseUrl,
      PGSSL: env.PGSSL || 'disable',
    }),
    { createGdprService },
  );
}

module.exports = { createTestDatabase };
