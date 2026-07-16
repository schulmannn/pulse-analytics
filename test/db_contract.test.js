'use strict';

// Публичный контракт server/db.js — снимок module.exports на момент старта доменного распила (P2).
// Гард против случайной ПОТЕРИ export'а при переносе SQL в repos/*: поведение НЕ проверяет (для
// этого integration-тесты на PG), только наличие и тип. Загружается DB-less (enabled=false) — pg
// установлен, но без DATABASE_URL всё мягко выключено, а функции всё равно определены.
//
// При добавлении/удалении публичного метода db.* — обновить этот список ОСОЗНАННО (не молча).

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');
const db = createTestDatabase();
const { mergeExports } = require('../server/db/mergeExports');

const EXPECTED_FUNCTIONS = [
  // core
  'init', 'migrate', 'ping', 'close', 'graphsToDailyRows', 'isDbUnavailable',
  // users
  'countUsers', 'createUser', 'getUserByEmail', 'getUserById', 'getUserAvatar', 'setUserAvatar',
  'listUsers', 'updateUser', 'setUserPassword', 'revokeUserSessions', 'setUserStatus',
  'createEmailToken', 'useEmailToken', 'pruneEmailTokens', 'getPrefs', 'setPrefs',
  // channels / workspaces / sources
  'adoptOwnerChannel', 'listChannels', 'getDefaultChannelId', 'getChannel', 'getChannelById', 'getOwnerChannelId',
  'getTgChannelIdentity', 'saveTgChannelAccessHash',
  'setChannelTgId', 'createChannel', 'createTgChannel', 'createIgChannel', 'findIgChannelByIgUser',
  'deleteChannel', 'createApiKey', 'getChannelByApiKey', 'listApiKeys', 'revokeApiKey',
  'ensurePersonalWorkspace', 'ensureExternalSource', 'ensureChannelCanonical',
  'listAnnotations', 'createAnnotation', 'deleteAnnotation',
  // collector writes
  'saveSnapshot', 'ingestCollectorPayload', 'persistCentralDaily', 'persistTgBundleTx',
  'getCollectorStatus', 'recordAuditEvent', 'saveVelocity',
  'upsertChannelDaily', 'upsertPosts', 'upsertMentions', 'upsertIgTags', 'getIgTags',
  'saveRawSnapshot', 'pruneRawSnapshots', 'pruneIgMediaDaily', 'pruneIngestReceipts', 'rollupChannelMonthly',
  'upsertIgDaily', 'upsertIgMediaDaily',
  // analytics reads (finding 5: контракт доступа — Internal для cron/service, ForActor для роутов;
  // голого un-gated db.getChannelHistory/getSnapshot/… в публичном API больше НЕТ)
  'getChannelHistoryInternal', 'getMentionsHistoryInternal', 'getMentionsArchiveInternal',
  'getSnapshotInternal', 'getLatestVelocityInternal', 'listPostsInternal', 'listIgDailyInternal', 'listIgMediaDailyInternal',
  'getPublicTgChannelPhoto',
  'getChannelHistoryForActor', 'getMentionsHistoryForActor', 'getMentionsArchiveForActor',
  'getSnapshotForActor', 'getLatestVelocityForActor', 'listPostsForActor', 'listIgDailyForActor', 'listIgMediaDailyForActor',
  // bugs / crashes
  'createBug', 'createCrash', 'upsertCrashSignature', 'recordCrashOccurrence', 'setCrashNotionPage', 'touchCrashNotified',
  'listBugs', 'updateBug', 'deleteBug', 'bugExists', 'getBug', 'addAttachmentIfRoom', 'getAttachment',
  // integrations (ig accounts / tg sessions)
  'saveIgAccount', 'getIgAccount', 'updateIgToken', 'deleteIgAccount', 'listIgAccounts',
  'saveTgSession', 'getTgSession', 'deleteTgSession', 'listTgSessions', 'rotateTgSessionCiphertext',
  'recordTgSessionAttempt', 'recordTgSessionSuccess', 'recordTgSessionFailure',
  // reportsRepo
  'listReports', 'getReport', 'createReport', 'updateReport', 'deleteReport', 'listDueReports',
  'markReportSent', 'reserveReportDelivery', 'clearReportDelivery', 'listPostsWindow',
  // campaignsRepo
  'listCampaigns', 'getCampaign', 'createCampaign', 'updateCampaign', 'deleteCampaign',
  'addCampaignPosts', 'removeCampaignPosts', 'listCampaignPosts', 'getCampaignSummary',
  // mentionSettingsRepo
  'getMentionSettingsInternal', 'getMentionSettingsForActor', 'upsertMentionSettingsForActor',
  // jobsRepo
  'claimJob', 'completeJob', 'failJob', 'getJob', 'runJobOnce', 'pruneTerminalJobs',
  // auditRepo
  'pruneAuditEvents',
  // gdpr
  'deleteUserAccount', 'exportUserData',
];

const EXPECTED_VALUES = [
  'USER_ROLES', 'USER_STATUSES', 'BUG_STATUSES', 'BUG_SEVERITIES', 'BUG_KINDS', 'REPORT_SCHEDULES',
  'CAMPAIGN_STATUSES', 'CAMPAIGN_NETWORKS', 'CAMPAIGN_POSTS_LIMIT', 'CAMPAIGN_BATCH_LIMIT',
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

// finding 3: сам список не должен содержать дублей (getLatestVelocity был указан дважды) —
// иначе «60 методов» врёт, а copy-paste при добавлении repo пройдёт незамеченным.
test('db контракт: EXPECTED_FUNCTIONS без дублей', () => {
  const dups = [...new Set(EXPECTED_FUNCTIONS.filter((n, i) => EXPECTED_FUNCTIONS.indexOf(n) !== i))];
  assert.deepStrictEqual(dups, [], `дубли в EXPECTED_FUNCTIONS: ${dups.join(', ')}`);
});

// finding 3: mergeExports — гард фасада. Коллизия имён между частями = ошибка загрузки (иначе один
// repo молча затирает метод другого). db.js собирается через него → любая реальная коллизия уронит
// и require('../server/db') выше, и этот прямой тест.
test('mergeExports: коллизия ключей между частями — throw', () => {
  assert.throws(() => mergeExports({ a: { foo() {} }, b: { foo() {} } }), /collision.*foo/);
});

test('mergeExports: непересекающиеся части сливаются, ключи сохраняются', () => {
  const merged = mergeExports({ a: { x: 1, y() {} }, b: { z: 3 } });
  assert.deepStrictEqual(Object.keys(merged).sort(), ['x', 'y', 'z']);
  assert.strictEqual(merged.x, 1);
  assert.strictEqual(merged.z, 3);
});
