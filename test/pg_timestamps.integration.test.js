'use strict';

// Integration: моменты (timestamptz), которые репозитории отдают СТРОКОЙ через to_char, обязаны
// разбираться JS-Date в любом поясе сессии Postgres. Раньше формат был '...SSOF': при целочасовом
// поясе (UTC на Railway, -03 на стенде) OF даёт голый '+00'/'-03', и new Date() → NaN. Следствия
// в проде: collector-status всегда stale=true, IG-токен не продлевался (igTokenState → 'none'),
// пустые «обновлён …» у отчётов, QR-сессии и кампаний.
//
// Каждую строку пишем НАСТОЯЩИМИ repo/SQL, читаем НАСТОЯЩИМИ repo-функциями через фасад, чей пул
// выставляет TimeZone сессии (+00:00, +03:00, -05:00, +05:30), и сверяем с сырым timestamptz
// (pg → Date) с точностью до секунды (to_char отбрасывает доли). Плюс два потребителя целиком:
// роут collector-status (stale) и продление IG-токена. Без TEST_DATABASE_URL всё SKIP.
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const express = require('express');
const { createTestDatabase } = require('./testDatabase');
const { registerCollectorRoutes } = require('../server/routes/collector');
const { igTokenState, igTokenDueForRefresh } = require('../server/domain/igToken');
const { createIgTokenRefreshJob } = require('../server/jobs/igTokenRefreshJob');
const { createInstagramClient } = require('../server/infrastructure/instagramClient');
const { toPublicQrStatus } = require('../server/lib/tgSessionStatus');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

// Пояса без перехода на летнее время — оффсет детерминирован в любой день года.
const ZONES = [
  ['UTC', '+00:00'],
  ['Europe/Moscow', '+03:00'],
  ['America/Bogota', '-05:00'],
  ['Asia/Kolkata', '+05:30'],
];
const DAY = 24 * 60 * 60 * 1000;

let db = null;       // фасад в поясе сервера по умолчанию — им сеем данные
let pool = null;
const zoneDb = {};   // tz → фасад, чья сессия живёт в этом поясе
const nonce = `pgts${Date.now().toString(36)}${process.pid}`;
const mail = (tag) => `${tag}.${nonce}@it.local`;
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const usedIg = [];
const S = {};

function withTimeZone(url, tz) {
  const u = new URL(url);
  u.searchParams.set('options', `-c TimeZone=${tz}`);
  return u.toString();
}

// Строка из репо разбирается JS-Date и совпадает с моментом в БД (доли секунды to_char отбрасывает).
function assertInstant(value, raw, label) {
  assert.strictEqual(typeof value, 'string', `${label}: ожидалась строка, пришло ${value}`);
  const ms = new Date(value).getTime();
  assert.ok(Number.isFinite(ms), `${label}: JS Date не разбирает '${value}'`);
  assert.ok(raw instanceof Date, `${label}: в БД нет момента`);
  const diff = raw.getTime() - ms;
  assert.ok(diff >= 0 && diff < 1000, `${label}: '${value}' ≠ ${raw.toISOString()} (Δ=${diff} мс)`);
}

async function rawTs(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0] ? rows[0].ts : null;
}

test.before(async () => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
  for (const [tz] of ZONES) zoneDb[tz] = createTestDatabase(withTimeZone(TEST_DB, tz));

  const tgId = Number(String(Date.now()).slice(-9)) + (process.pid % 1000);
  S.owner = await db.createUser({ email: mail('owner'), pass_hash: 'x', role: 'user', status: 'active' });
  S.tg = await db.createTgChannel({ owner_uid: S.owner.id, tg_channel_id: tgId, username: `tg_${nonce}`, title: 'TS' });
  S.collector = await db.createChannel({ owner_uid: S.owner.id, username: `col_${nonce}`, title: 'Col' });
  S.staleCollector = await db.createChannel({ owner_uid: S.owner.id, username: `cold_${nonce}`, title: 'Cold' });

  // IG: внутри окна продления, далеко от него и уже истёкший.
  const now = Date.now();
  for (const [key, expiresAt] of [['igDue', now + 5 * DAY], ['igFar', now + 40 * DAY], ['igExpired', now - DAY]]) {
    S[key] = await db.createIgChannel({ owner_uid: S.owner.id, username: `${key}_${nonce}` });
    const ig = `ig${nonce}_${key}`;
    usedIg.push(ig);
    await db.saveIgAccount(S[key].id, {
      ig_user_id: ig, username: `${key}_${nonce}`, access_token_enc: `enc:${key}`,
      token_expires_at: new Date(expiresAt), scopes: 'basic',
    });
  }

  // collector_status: свежий успех (5 минут назад) и честно протухший (30 ч назад).
  await pool.query(
    `INSERT INTO collector_status (channel_id, collector_version, last_ingest_id, last_attempt_at, last_success_at)
     VALUES ($1,'1.0.0','ing-fresh',now(),now() - interval '5 minutes'),
            ($2,'1.0.0','ing-cold',now(),now() - interval '30 hours')`,
    [S.collector.id, S.staleCollector.id]);

  // QR-сессия: все три last_* непустые одновременно.
  await db.saveTgSession(S.owner.id, { tg_user_id: 4242, username: `tgu_${nonce}`, session_enc: 'enc:s' });
  await pool.query(
    `UPDATE tg_sessions SET last_attempt_at = now(), last_success_at = now() - interval '1 hour',
            last_error_at = now() - interval '2 hours', last_error_code = 'unknown' WHERE uid = $1`,
    [S.owner.id]);

  S.report = await db.createReport(S.owner.id, `Отчёт ${nonce}`, { blocks: [] });

  await pool.query(
    `INSERT INTO posts (post_id, channel_id, date_published, views, media_type, caption)
     VALUES (501, $1, '2026-06-10T10:00:00.250Z', 100, 'text', 'пост кампании')
     ON CONFLICT (channel_id, post_id) DO NOTHING`, [S.tg.id]);
  S.campaign = await db.createCampaign(S.owner.id, { channel_id: S.tg.id, name: `Кампания ${nonce}` });
  const added = await db.addCampaignPosts(S.owner.id, S.campaign.id, [
    { network: 'tg', channel_id: S.tg.id, post_ref: '501' },
  ]);
  assert.strictEqual(added.added, 1, 'пост кампании добавлен');

  S.chat = await db.createAiChat(S.owner.id);
  S.message = await db.appendAiChatMessage(S.owner.id, S.chat.id, { role: 'user', content: 'Привет' });

  assert.ok(await db.upsertMentionSettingsForActor(S.tg.id, { uid: S.owner.id }, { include_terms: ['атлавью'] }));

  const tokenHash = sha(`tok-${nonce}`);
  assert.ok(await db.issueMentionNotifyLink(S.owner.id, tokenHash, 15));
  const chatId = 700000000 + (Date.now() % 100000000);
  assert.strictEqual(await db.bindMentionNotifyByToken(tokenHash, { chat_id: chatId, tg_user_id: 1, username: 'u' }), S.owner.id);
  assert.ok(await db.setMentionNotifySubscriptionForActor(S.tg.id, { uid: S.owner.id }, true));
  assert.strictEqual(await db.markMentionNotifyRun(S.tg.id, S.owner.id, { notified: true }), true);

  await db.setMsBackfillState(S.tg.id, { status: 'running', started_at: new Date(now - 60_000) });
  await db.setMsReturnsBackfillState(S.tg.id, { status: 'running', started_at: new Date(now - 60_000) });
});

test.after(async () => {
  for (const d of Object.values(zoneDb)) await d.close();
  if (db) await db.close();
  if (!pool) return;
  // users каскадят каналы (→ ig_accounts, collector_status, кампании, настройки, ms_*_state),
  // tg_sessions, отчёты, AI-чаты и привязки бота; общие таблицы чистим руками.
  if (S.tg) await pool.query('DELETE FROM posts WHERE channel_id = $1', [S.tg.id]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%${nonce}%`]);
  await pool.query('DELETE FROM external_sources WHERE external_id = ANY($1) OR username LIKE $2', [usedIg, `%${nonce}%`]);
  await pool.end();
});

// Каждый случай: чтение через настоящий repo (строка) + сырой момент той же колонки.
const CASES = [
  ['integrationsRepo.getIgAccount.token_expires_at',
    async (d) => (await d.getIgAccount(S.igDue.id)).token_expires_at,
    () => rawTs('SELECT token_expires_at AS ts FROM ig_accounts WHERE channel_id=$1', [S.igDue.id])],
  ['integrationsRepo.listIgAccounts.token_expires_at',
    async (d) => (await d.listIgAccounts()).find((a) => a.channel_id === S.igFar.id).token_expires_at,
    () => rawTs('SELECT token_expires_at AS ts FROM ig_accounts WHERE channel_id=$1', [S.igFar.id])],
  ...['last_attempt_at', 'last_success_at', 'last_error_at'].flatMap((col) => [
    [`integrationsRepo.getTgSession.${col}`,
      async (d) => (await d.getTgSession(S.owner.id))[col],
      () => rawTs(`SELECT ${col} AS ts FROM tg_sessions WHERE uid=$1`, [S.owner.id])],
    [`integrationsRepo.listTgSessions.${col}`,
      async (d) => (await d.listTgSessions()).find((s) => s.uid === S.owner.id)[col],
      () => rawTs(`SELECT ${col} AS ts FROM tg_sessions WHERE uid=$1`, [S.owner.id])],
  ]),
  ...['last_attempt_at', 'last_success_at'].map((col) => [
    `analyticsRepo.getCollectorStatus.${col}`,
    async (d) => (await d.getCollectorStatus(S.collector.id, { uid: S.owner.id }))[col],
    () => rawTs(`SELECT ${col} AS ts FROM collector_status WHERE channel_id=$1`, [S.collector.id])]),
  ...['created_at', 'updated_at'].flatMap((col) => [
    [`reportsRepo.getReport.${col}`,
      async (d) => (await d.getReport(S.owner.id, S.report.id))[col],
      () => rawTs(`SELECT ${col} AS ts FROM reports WHERE id=$1`, [S.report.id])],
    [`campaignsRepo.getCampaign.${col}`,
      async (d) => (await d.getCampaign(S.owner.id, S.campaign.id))[col],
      () => rawTs(`SELECT ${col} AS ts FROM campaigns WHERE id=$1`, [S.campaign.id])],
    [`aiChatsRepo.getAiChat.${col}`,
      async (d) => (await d.getAiChat(S.owner.id, S.chat.id))[col],
      () => rawTs(`SELECT ${col} AS ts FROM ai_chats WHERE id=$1`, [S.chat.id])],
    [`aiChatsRepo.listAiChats.${col}`,
      async (d) => (await d.listAiChats(S.owner.id)).find((c) => c.id === S.chat.id)[col],
      () => rawTs(`SELECT ${col} AS ts FROM ai_chats WHERE id=$1`, [S.chat.id])],
  ]),
  ...['published_at', 'added_at'].map((col) => [
    `campaignsRepo.listCampaignPosts.${col}`,
    async (d) => (await d.listCampaignPosts(S.owner.id, S.campaign.id))[0][col],
    () => rawTs(`SELECT ${col} AS ts FROM campaign_posts WHERE campaign_id=$1`, [S.campaign.id])]),
  ['aiChatsRepo.listAiChatMessages.created_at',
    async (d) => (await d.listAiChatMessages(S.owner.id, S.chat.id)).find((m) => m.id === S.message.id).created_at,
    () => rawTs('SELECT created_at AS ts FROM ai_chat_messages WHERE id=$1', [S.message.id])],
  ['mentionSettingsRepo.getMentionSettingsInternal.updated_at',
    async (d) => (await d.getMentionSettingsInternal(S.tg.id)).updated_at,
    () => rawTs('SELECT updated_at AS ts FROM channel_mention_settings WHERE channel_id=$1', [S.tg.id])],
  ['mentionNotifyRepo.getMentionNotifyBinding.bound_at',
    async (d) => (await d.getMentionNotifyBinding(S.owner.id)).bound_at,
    () => rawTs('SELECT bound_at AS ts FROM tg_notify_bindings WHERE uid=$1', [S.owner.id])],
  ...['last_run_at', 'last_notified_at'].map((col) => [
    `mentionNotifyRepo.getMentionNotifySubscription.${col}`,
    async (d) => (await d.getMentionNotifySubscription(S.tg.id, S.owner.id))[col],
    () => rawTs(`SELECT ${col} AS ts FROM mention_notify_subscriptions WHERE channel_id=$1 AND uid=$2`, [S.tg.id, S.owner.id])]),
  ['mentionNotifyRepo.getRunnableMentionNotifySubscription.last_notified_at',
    async (d) => (await d.getRunnableMentionNotifySubscription(S.tg.id, S.owner.id)).last_notified_at,
    () => rawTs('SELECT last_notified_at AS ts FROM mention_notify_subscriptions WHERE channel_id=$1 AND uid=$2', [S.tg.id, S.owner.id])],
  ...['started_at', 'updated_at'].flatMap((col) => [
    [`collectorRepo.getMsBackfillState.${col}`,
      async (d) => (await d.getMsBackfillState(S.tg.id))[col],
      () => rawTs(`SELECT ${col} AS ts FROM ms_backfill_state WHERE channel_id=$1`, [S.tg.id])],
    [`collectorRepo.getMsReturnsBackfillState.${col}`,
      async (d) => (await d.getMsReturnsBackfillState(S.tg.id))[col],
      () => rawTs(`SELECT ${col} AS ts FROM ms_returns_backfill_state WHERE channel_id=$1`, [S.tg.id])],
  ]),
];

for (const [tz, offset] of ZONES) {
  test(`[${tz}] каждый момент из репо — строка с оффсетом ${offset}, которую JS Date разбирает`, { skip }, async () => {
    const d = zoneDb[tz];
    for (const [label, read, raw] of CASES) {
      const value = await read(d);
      assertInstant(value, await raw(), `${label} @ ${tz}`);
      assert.ok(value.endsWith(offset), `${label} @ ${tz}: ожидался оффсет ${offset}, пришло '${value}'`);
    }
  });

  test(`[${tz}] IG-токен из БД: окно продления видно, крон берёт в работу только «пора продлевать»`, { skip }, async () => {
    const d = zoneDb[tz];
    const due = await d.getIgAccount(S.igDue.id);
    assert.strictEqual(igTokenState(due.token_expires_at), 'expiring', `'${due.token_expires_at}'`);
    assert.strictEqual(igTokenDueForRefresh(due.token_expires_at), true);
    assert.strictEqual(igTokenState((await d.getIgAccount(S.igFar.id)).token_expires_at), 'ok');
    const expired = await d.getIgAccount(S.igExpired.id);
    assert.strictEqual(igTokenState(expired.token_expires_at), 'expired', 'истёкший токен честно «expired», а не «none»');
    assert.strictEqual(igTokenDueForRefresh(expired.token_expires_at), false);

    // Настоящий job поверх настоящего listIgAccounts: в работу идёт только аккаунт внутри окна.
    const picked = [];
    const job = createIgTokenRefreshJob({
      db: d,
      igCrypto: { configured: () => true, decrypt: (enc) => `plain(${enc})` },
      refreshIgIfNeeded: async (channelId, token) => { picked.push(channelId); return token; },
    });
    const stats = await job.processIgTokenRefresh();
    assert.ok(stats.due >= 1, 'хотя бы один аккаунт в окне продления');
    assert.ok(picked.includes(S.igDue.id), 'аккаунт внутри окна взят в продление');
    assert.ok(!picked.includes(S.igFar.id), 'далёкий от истечения не трогаем');
    assert.ok(!picked.includes(S.igExpired.id), 'истёкший продлить нельзя — только реконнект');
  });

  test(`[${tz}] refreshIgIfNeeded на строке из БД реально продлевает токен и персистит новый срок`, { skip }, async () => {
    const d = zoneDb[tz];
    const ch = await db.createIgChannel({ owner_uid: S.owner.id, username: `ref_${tz.replace(/\W/g, '')}_${nonce}` });
    const ig = `ig${nonce}_ref_${tz.replace(/\W/g, '')}`;
    usedIg.push(ig);
    await db.saveIgAccount(ch.id, {
      ig_user_id: ig, username: `ref_${nonce}`, access_token_enc: 'enc:OLD',
      token_expires_at: new Date(Date.now() + 3 * DAY), scopes: 'basic',
    });
    const fetched = [];
    const client = createInstagramClient({
      db: d,
      log: () => {},
      igCrypto: { encrypt: (t) => `enc:${t}` },
      fetchImpl: async (url) => {
        fetched.push(url);
        return { status: 200, json: async () => ({ access_token: 'NEW', expires_in: 60 * 24 * 60 * 60 }) };
      },
    });
    const acc = await d.getIgAccount(ch.id);
    const token = await client.refreshIgIfNeeded(ch.id, 'OLD', acc.token_expires_at);
    assert.strictEqual(token, 'NEW', `токен со сроком '${acc.token_expires_at}' продлён`);
    assert.strictEqual(fetched.length, 1, 'ровно один вызов refresh_access_token');
    const after = await d.getIgAccount(ch.id);
    assert.strictEqual(after.access_token_enc, 'enc:NEW', 'новый токен сохранён');
    assert.strictEqual(igTokenState(after.token_expires_at), 'ok', 'новый срок читается и вне окна продления');
  });

  test(`[${tz}] GET collector-status: свежий last_success_at из БД → stale=false, протухший → stale=true`, { skip }, async (t) => {
    const app = express();
    const pass = (_req, _res, next) => next();
    registerCollectorRoutes({
      app,
      db: zoneDb[tz],
      express,
      rateLimit: () => pass,
      isReady: () => true,
      requireAuth: (req, _res, next) => { req.user = { uid: S.owner.id }; next(); },
      audit: () => {},
      collectorStaleHours: 24,
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;

    const fresh = await (await fetch(`${base}/api/channels/${S.collector.id}/collector-status`)).json();
    assert.ok(Number.isFinite(new Date(fresh.status.last_success_at).getTime()), `'${fresh.status.last_success_at}'`);
    assert.strictEqual(fresh.status.stale, false, 'агент отработал 5 минут назад — не stale');
    assert.strictEqual(fresh.status.stale_after_hours, 24);

    const cold = await (await fetch(`${base}/api/channels/${S.staleCollector.id}/collector-status`)).json();
    assert.strictEqual(cold.status.stale, true, 'успех 30 ч назад при пороге 24 ч — stale');
  });

  test(`[${tz}] /api/tg/qr/status-форма: last_success_at QR-сессии разбирается JS Date`, { skip }, async () => {
    const out = toPublicQrStatus(await zoneDb[tz].getTgSession(S.owner.id), { serverReady: true });
    for (const col of ['last_attempt_at', 'last_success_at', 'last_error_at']) {
      assert.ok(Number.isFinite(new Date(out[col]).getTime()), `${col}: '${out[col]}'`);
    }
  });
}
