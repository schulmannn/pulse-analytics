'use strict';

// Публичный контракт server/db.js — снимок module.exports на момент старта доменного распила (P2).
// Гард против случайной ПОТЕРИ export'а при переносе SQL в repos/*: поведение НЕ проверяет (для
// этого integration-тесты на PG), только наличие и тип. Загружается DB-less (enabled=false) — pg
// установлен, но без DATABASE_URL всё мягко выключено, а функции всё равно определены.
//
// При добавлении/удалении публичного метода db.* — обновить этот список ОСОЗНАННО (не молча).

const test = require('node:test');
const assert = require('node:assert');
const db = require('../server/db');

const EXPECTED_FUNCTIONS = [
  // core
  'init', 'migrate', 'ping', 'close', 'graphsToDailyRows', 'isDbUnavailable',
  // users
  'countUsers', 'createUser', 'getUserByEmail', 'getUserById', 'getUserAvatar', 'setUserAvatar',
  'listUsers', 'updateUser', 'setUserPassword', 'revokeUserSessions', 'setUserStatus',
  'createEmailToken', 'useEmailToken', 'getPrefs', 'setPrefs',
  // channels / workspaces / sources
  'adoptOwnerChannel', 'listChannels', 'getChannel', 'getChannelById', 'getOwnerChannelId',
  'setChannelTgId', 'createChannel', 'createTgChannel', 'createIgChannel', 'findIgChannelByIgUser',
  'deleteChannel', 'createApiKey', 'getChannelByApiKey', 'listApiKeys', 'revokeApiKey',
  'ensurePersonalWorkspace', 'ensureExternalSource', 'ensureChannelCanonical',
  'listAnnotations', 'createAnnotation', 'deleteAnnotation',
  // collector writes
  'saveSnapshot', 'getSnapshot', 'ingestCollectorPayload', 'persistCentralDaily', 'persistTgBundleTx',
  'getCollectorStatus', 'recordAuditEvent', 'saveVelocity', 'getLatestVelocity',
  'upsertChannelDaily', 'upsertPosts', 'upsertMentions', 'upsertIgTags', 'getIgTags',
  'saveRawSnapshot', 'pruneRawSnapshots', 'pruneIgMediaDaily', 'rollupChannelMonthly',
  'upsertIgDaily', 'upsertIgMediaDaily',
  // analytics reads
  'getChannelHistory', 'getMentionsHistory', 'getMentionsArchive', 'getLatestVelocity',
  'listIgDaily', 'listIgMediaDaily',
  // bugs / crashes
  'createBug', 'createCrash', 'upsertCrashSignature', 'setCrashNotionPage', 'touchCrashNotified',
  'listBugs', 'updateBug', 'deleteBug', 'bugExists', 'getBug', 'addAttachmentIfRoom', 'getAttachment',
  // integrations (ig accounts / tg sessions)
  'saveIgAccount', 'getIgAccount', 'updateIgToken', 'deleteIgAccount', 'listIgAccounts',
  'saveTgSession', 'getTgSession', 'deleteTgSession', 'listTgSessions',
  // reportsRepo
  'listReports', 'getReport', 'createReport', 'updateReport', 'deleteReport', 'listDueReports',
  'markReportSent', 'listPostsWindow',
  // jobsRepo
  'claimJob', 'completeJob', 'failJob', 'getJob', 'runJobOnce',
  // gdpr
  'deleteUserAccount', 'exportUserData',
];

const EXPECTED_VALUES = [
  'USER_ROLES', 'USER_STATUSES', 'BUG_STATUSES', 'BUG_SEVERITIES', 'BUG_KINDS', 'REPORT_SCHEDULES',
];

test('db контракт: все ожидаемые методы — функции (гард против потери export при распиле)', () => {
  const missing = EXPECTED_FUNCTIONS.filter((name) => typeof db[name] !== 'function');
  assert.deepStrictEqual(missing, [], `отсутствуют/не-функции: ${missing.join(', ')}`);
});

test('db контракт: enabled — boolean, справочники/константы определены', () => {
  assert.strictEqual(typeof db.enabled, 'boolean', 'db.enabled должен быть boolean');
  const missing = EXPECTED_VALUES.filter((name) => db[name] === undefined);
  assert.deepStrictEqual(missing, [], `отсутствуют value-export'ы: ${missing.join(', ')}`);
});
