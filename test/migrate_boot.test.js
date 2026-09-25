'use strict';

// Точка входа миграций (server/migrate.js, `npm start` зовёт её перед web) валидирует тот же
// config, что и web. Регресс: дефолтный GDPR_EXPORT_MAX_CONCURRENT=2 при PGPOOL_MAX=2 был фатальным
// ConfigError, и прод с маленьким пулом не доходил даже до миграций. Настоящий процесс, без PG:
// ALLOW_DBLESS + пустой DATABASE_URL → «migrations skipped» и код 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MIGRATE = path.join(__dirname, '..', 'server', 'migrate.js');

test('migrate.js: прод-конфиг с маленьким PGPOOL_MAX не падает на лимите GDPR-выгрузок', () => {
  const result = spawnSync(process.execPath, [MIGRATE], {
    cwd: path.join(__dirname, '..'),
    // DATABASE_URL задан пустым явно: dotenv не перезаписывает заданные ключи, локальный .env не
    // подсунет живую базу.
    env: {
      NODE_ENV: 'production', SESSION_SECRET: 's', APP_URL: 'https://atlavue.app',
      ALLOW_DBLESS: 'true', DATABASE_URL: '', PGPOOL_MAX: '2',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 0, `migrate.js завершился с ошибкой:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /migrations skipped/);
  assert.doesNotMatch(result.stderr, /config validation failed|gdprExportMaxConcurrent/);
});
