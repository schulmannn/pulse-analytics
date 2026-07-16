'use strict';

// Integration-тесты integrationsRepo (P2 db-split PR 4) — на РЕАЛЬНОМ Postgres. Домен секретов:
// IG OAuth-аккаунты (access_token_enc), TG QR-сессии (session_enc), ig-теги, connection-status
// коллектора. Токены тут — уже-шифрованные СТРОКИ-заглушки (repo не видит plaintext по контракту).
// Без TEST_DATABASE_URL всё SKIP. CI (postgres) и локальный стенд:
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `irepo${Date.now().toString(36)}${process.pid}`;
let seq = 0;
const mail = (tag) => `${tag}.${seq++}.${nonce}@it.local`;
let igSeq = 0;
const usedIg = [];
const igId = () => { const v = `ig${nonce}_${igSeq++}`; usedIg.push(v); return v; };

const mkUser = (tag) => db.createUser({ email: mail(tag), pass_hash: 'x', role: 'user', status: 'active' });

test.before(() => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  // users каскадят channels → ig_accounts/collector_status; tg_sessions по uid. Общие таблицы без
  // каскада чистим руками: external_sources (по нашим ig-id) и глобальный ig_tags (по media_id-нонсу).
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM external_sources WHERE external_id = ANY($1)`, [usedIg]);
  await pool.query(`DELETE FROM ig_tags WHERE media_id LIKE $1`, [`tag${nonce}%`]);
  await pool.end();
});

test('saveIgAccount: транзакция целиком — аккаунт + external_source(ig) + штамп source_id standalone-IG-канала', { skip }, async () => {
  const O = await mkUser('sa');
  const ch = await db.createIgChannel({ owner_uid: O.id, username: `insta_${nonce}` });
  const ig = igId();
  const ok = await db.saveIgAccount(ch.id, {
    ig_user_id: ig, username: `insta_${nonce}`, access_token_enc: 'enc:tok1', token_expires_at: null, scopes: 'basic',
  });
  assert.strictEqual(ok, true);

  const acc = await db.getIgAccount(ch.id);
  assert.strictEqual(acc.ig_user_id, ig);
  assert.strictEqual(acc.access_token_enc, 'enc:tok1', 'репо отдаёт шифрованный токен как есть');

  const src = await pool.query(`SELECT id FROM external_sources WHERE network='ig' AND external_id=$1`, [ig]);
  assert.strictEqual(src.rows.length, 1, 'canonical ig-source создан');
  const chRow = await pool.query(`SELECT source_id FROM channels WHERE id=$1`, [ch.id]);
  assert.strictEqual(chRow.rows[0].source_id, src.rows[0].id, 'standalone IG-канал проштампован source_id');
});

test('saveIgAccount reconnect (тот же канал): upsert по channel_id — токен ротируется, дубля нет', { skip }, async () => {
  const O = await mkUser('rc');
  const ch = await db.createIgChannel({ owner_uid: O.id, username: `rec_${nonce}` });
  const ig = igId();
  await db.saveIgAccount(ch.id, { ig_user_id: ig, username: `rec_${nonce}`, access_token_enc: 'enc:old', scopes: 'basic' });
  await db.saveIgAccount(ch.id, { ig_user_id: ig, username: `rec_${nonce}`, access_token_enc: 'enc:new', scopes: 'basic,insights' });
  const acc = await db.getIgAccount(ch.id);
  assert.strictEqual(acc.access_token_enc, 'enc:new', 'reconnect ротирует токен');
  assert.strictEqual(acc.scopes, 'basic,insights');
  const n = (await pool.query(`SELECT count(*)::int n FROM ig_accounts WHERE channel_id=$1`, [ch.id])).rows[0].n;
  assert.strictEqual(n, 1, 'один аккаунт на канал (без дублей)');
});

test('updateIgToken: ротация токена/expiry БЕЗ смены identity; deleteIgAccount → getIgAccount null', { skip }, async () => {
  const O = await mkUser('ut');
  const ch = await db.createIgChannel({ owner_uid: O.id, username: `upd_${nonce}` });
  const ig = igId();
  await db.saveIgAccount(ch.id, { ig_user_id: ig, username: `upd_${nonce}`, access_token_enc: 'enc:a', scopes: 's' });
  await db.updateIgToken(ch.id, 'enc:b', '2027-01-01T00:00:00Z');
  const acc = await db.getIgAccount(ch.id);
  assert.strictEqual(acc.access_token_enc, 'enc:b', 'токен ротирован');
  assert.strictEqual(acc.ig_user_id, ig, 'identity не тронута');
  // Сравниваем МОМЕНТ, не строку: to_char(...OF) рендерит в TZ сервера (CI=UTC, стенд=-03),
  // а голый часовой оффсет ("-03") JS-Date не парсит → нормализуем до "-03:00".
  const expiryIso = new Date(acc.token_expires_at.replace(/([+-]\d{2})$/, '$1:00')).toISOString();
  assert.strictEqual(expiryIso, '2027-01-01T00:00:00.000Z', 'expiry обновлён');

  assert.strictEqual(await db.deleteIgAccount(ch.id), true);
  assert.strictEqual(await db.getIgAccount(ch.id), null, 'после отключения — null');
  assert.strictEqual(await db.deleteIgAccount(ch.id), false, 'повторное удаление — чистый false');
});

test('listIgAccounts (cron-путь): все подключённые аккаунты с шифрованным токеном', { skip }, async () => {
  const O = await mkUser('li');
  const ch1 = await db.createIgChannel({ owner_uid: O.id, username: `l1_${nonce}` });
  const ch2 = await db.createIgChannel({ owner_uid: O.id, username: `l2_${nonce}` });
  await db.saveIgAccount(ch1.id, { ig_user_id: igId(), username: `l1_${nonce}`, access_token_enc: 'enc:1' });
  await db.saveIgAccount(ch2.id, { ig_user_id: igId(), username: `l2_${nonce}`, access_token_enc: 'enc:2' });
  const all = await db.listIgAccounts();
  const mine = all.filter((a) => [ch1.id, ch2.id].includes(a.channel_id));
  assert.strictEqual(mine.length, 2, 'оба аккаунта в cron-списке');
  assert.ok(mine.every((a) => a.access_token_enc.startsWith('enc:')), 'токены на месте (callers decrypt)');
});

test('tg_sessions: upsert per-uid (reconnect ротирует session_enc), get/list/delete', { skip }, async () => {
  const U = await mkUser('tg');
  await db.saveTgSession(U.id, { tg_user_id: 111, username: `tgu_${nonce}`, session_enc: 'enc:s1' });
  await db.saveTgSession(U.id, { tg_user_id: 111, username: `tgu_${nonce}`, session_enc: 'enc:s2' });
  const sess = await db.getTgSession(U.id);
  assert.strictEqual(sess.session_enc, 'enc:s2', 'reconnect ротирует session_enc (upsert, не дубль)');
  const n = (await pool.query(`SELECT count(*)::int n FROM tg_sessions WHERE uid=$1`, [U.id])).rows[0].n;
  assert.strictEqual(n, 1, 'одна сессия на uid');
  assert.ok((await db.listTgSessions()).some((s2) => s2.uid === U.id), 'cron-список видит сессию');
  assert.strictEqual(await db.deleteTgSession(U.id), true);
  assert.strictEqual(await db.getTgSession(U.id), null, 'после отключения — null');
});

test('tg_sessions health: свежая сессия → healthy; attempt/success/failure переходы', { skip }, async () => {
  const U = await mkUser('tgh');
  // Fresh connect: connection_state defaults to healthy, no error fields.
  await db.saveTgSession(U.id, { tg_user_id: 222, username: `h_${nonce}`, session_enc: 'enc:h0' });
  let s = await db.getTgSession(U.id);
  assert.strictEqual(s.connection_state, 'healthy', 'свежая сессия — healthy');
  assert.strictEqual(s.last_error_code, null);
  assert.strictEqual(s.last_success_at, null);

  // Real attempt stamps last_attempt_at (state unchanged).
  const version = s.session_version;
  assert.strictEqual(await db.recordTgSessionAttempt(U.id, version), true);
  s = await db.getTgSession(U.id);
  assert.ok(s.last_attempt_at, 'last_attempt_at проставлен');
  assert.strictEqual(s.connection_state, 'healthy');

  // Auth failure → reauth_required + allow-listed error code.
  assert.strictEqual(await db.recordTgSessionFailure(U.id, version, { state: 'reauth_required', errorCode: 'session_unauthorized' }), true);
  s = await db.getTgSession(U.id);
  assert.strictEqual(s.connection_state, 'reauth_required');
  assert.strictEqual(s.last_error_code, 'session_unauthorized');
  assert.ok(s.last_error_at, 'last_error_at проставлен');

  // Success clears the error and flips back to healthy.
  assert.strictEqual(await db.recordTgSessionSuccess(U.id, version), true);
  s = await db.getTgSession(U.id);
  assert.strictEqual(s.connection_state, 'healthy');
  assert.strictEqual(s.last_error_code, null, 'success снимает ошибку');
  assert.strictEqual(s.last_error_at, null);
  assert.ok(s.last_success_at, 'last_success_at проставлен');
});

test('tg_sessions health: failure санитайзит state/errorCode (без caller-controlled state)', { skip }, async () => {
  const U = await mkUser('tgs');
  await db.saveTgSession(U.id, { tg_user_id: 333, username: `s_${nonce}`, session_enc: 'enc:s0' });
  const version = (await db.getTgSession(U.id)).session_version;
  // Bogus state → coerced to 'degraded'; bogus/injection-y code → coerced to 'unknown'. If either
  // reached the DB raw, the CHECK constraint (or worse) would break — the repo guarantees it can't.
  assert.strictEqual(await db.recordTgSessionFailure(U.id, version, { state: "healthy'; DROP TABLE tg_sessions;--", errorCode: 'nonsense' }), true);
  const s = await db.getTgSession(U.id);
  assert.strictEqual(s.connection_state, 'degraded', 'нелегальный state → degraded');
  assert.strictEqual(s.last_error_code, 'unknown', 'нелегальный код → unknown');
});

test('tg_sessions health: reconnect (saveTgSession) сбрасывает health в healthy и чистит ошибку', { skip }, async () => {
  const U = await mkUser('tgr');
  await db.saveTgSession(U.id, { tg_user_id: 444, username: `r_${nonce}`, session_enc: 'enc:r0' });
  let s = await db.getTgSession(U.id);
  const oldVersion = s.session_version;
  await db.recordTgSessionFailure(U.id, oldVersion, { state: 'reauth_required', errorCode: 'session_unauthorized' });
  s = await db.getTgSession(U.id);
  assert.strictEqual(s.connection_state, 'reauth_required', 'предусловие: сессия в reauth_required');

  // Reconnect (пере-скан QR) ротирует session_enc И сбрасывает health.
  await db.saveTgSession(U.id, { tg_user_id: 444, username: `r_${nonce}`, session_enc: 'enc:r1' });
  s = await db.getTgSession(U.id);
  assert.strictEqual(s.session_enc, 'enc:r1', 'reconnect ротирует сессию');
  assert.strictEqual(s.connection_state, 'healthy', 'reconnect → healthy');
  assert.notStrictEqual(s.session_version, oldVersion, 'reconnect increments the optimistic generation');
  assert.strictEqual(s.last_error_code, null, 'reconnect чистит error-код');
  assert.strictEqual(s.last_error_at, null);
  // A late collector result from the old encrypted session must not poison the fresh connection.
  assert.strictEqual(
    await db.recordTgSessionFailure(U.id, oldVersion, { state: 'reauth_required', errorCode: 'session_unauthorized' }),
    false,
  );
  assert.strictEqual((await db.getTgSession(U.id)).connection_state, 'healthy');
});

test('rotateTgSessionCiphertext: переписывает ТОЛЬКО session_enc под тем же поколением, без version/health/identity', { skip }, async () => {
  const U = await mkUser('rot');
  await db.saveTgSession(U.id, { tg_user_id: 666, username: `rot_${nonce}`, session_enc: 'enc:v1' });
  // Пометим сессию как degraded с последней ошибкой/попыткой — rewrite не должен это трогать.
  const before = await db.getTgSession(U.id);
  const version = before.session_version;
  await db.recordTgSessionFailure(U.id, version, { state: 'degraded', errorCode: 'mtproto_timeout' });
  const beforeRewrite = await db.getTgSession(U.id);

  const matched = await db.rotateTgSessionCiphertext(U.id, version, 'enc:reencrypted');
  assert.strictEqual(matched, true, 'совпадающее поколение → true');

  const after = await db.getTgSession(U.id);
  assert.strictEqual(after.session_enc, 'enc:reencrypted', 'ciphertext переписан');
  assert.strictEqual(after.session_version, version, 'session_version НЕ инкрементируется');
  assert.strictEqual(after.tg_user_id, beforeRewrite.tg_user_id, 'tg_user_id не тронут');
  assert.strictEqual(after.username, beforeRewrite.username, 'username не тронут');
  assert.strictEqual(after.connection_state, 'degraded', 'connection_state не тронут');
  assert.strictEqual(after.last_error_code, 'mtproto_timeout', 'health-ошибка не тронута');
  assert.strictEqual(after.last_error_at, beforeRewrite.last_error_at, 'last_error_at не тронут');
});

test('rotateTgSessionCiphertext: устаревшее/чужое поколение → no-op false, ciphertext не меняется', { skip }, async () => {
  const U = await mkUser('rotstale');
  await db.saveTgSession(U.id, { tg_user_id: 777, username: `rs_${nonce}`, session_enc: 'enc:a' });
  const oldVersion = (await db.getTgSession(U.id)).session_version;
  // Reconnect инкрементирует поколение (симулируем гонку переподключения).
  await db.saveTgSession(U.id, { tg_user_id: 777, username: `rs_${nonce}`, session_enc: 'enc:b' });
  const newVersion = (await db.getTgSession(U.id)).session_version;
  assert.notStrictEqual(newVersion, oldVersion);

  // Ленивое переписывание из прежнего поколения не должно затирать свежую сессию.
  const matched = await db.rotateTgSessionCiphertext(U.id, oldVersion, 'enc:stale');
  assert.strictEqual(matched, false, 'устаревшее поколение → no-op');
  assert.strictEqual((await db.getTgSession(U.id)).session_enc, 'enc:b', 'свежий ciphertext сохранён');

  // Невалидное поколение / отсутствующий uid → чистый false без записи.
  assert.strictEqual(await db.rotateTgSessionCiphertext(U.id, '0', 'enc:x'), false, 'невалидная version → false');
  assert.strictEqual(await db.rotateTgSessionCiphertext(999999999, newVersion, 'enc:x'), false, 'нет строки → false');
});

test('tg_sessions health: listTgSessions отдаёт health-поля (cron-путь)', { skip }, async () => {
  const U = await mkUser('tgl');
  await db.saveTgSession(U.id, { tg_user_id: 555, username: `l_${nonce}`, session_enc: 'enc:l0' });
  const version = (await db.getTgSession(U.id)).session_version;
  await db.recordTgSessionFailure(U.id, version, { state: 'degraded', errorCode: 'mtproto_timeout' });
  const row = (await db.listTgSessions()).find((r) => r.uid === U.id);
  assert.ok(row, 'сессия в cron-списке');
  assert.strictEqual(row.connection_state, 'degraded');
  assert.strictEqual(row.last_error_code, 'mtproto_timeout');
  assert.ok('session_enc' in row, 'cron-путь всё ещё несёт session_enc (только для сервера)');
});

test('tg_sessions health: record-методы на отсутствующем uid → false', { skip }, async () => {
  assert.strictEqual(await db.recordTgSessionAttempt(999999999, '1'), false);
  assert.strictEqual(await db.recordTgSessionSuccess(999999999, '1'), false);
  assert.strictEqual(await db.recordTgSessionFailure(999999999, '1', { state: 'degraded', errorCode: 'unknown' }), false);
});

test('listTgQrCollectCandidates: qr/active/owned, session≠reauth, job-state exclusion, deterministic limit', { skip }, async () => {
  const day = '2026-07-16';
  const O = await mkUser('cand');
  await db.saveTgSession(O.id, { tg_user_id: 900, username: `cand_${nonce}`, session_enc: 'enc:cand' });

  let tg = 7770000 + (process.pid % 1000) * 1000;
  const mkCh = async () => {
    tg += 1;
    return db.createTgChannel({ owner_uid: O.id, tg_channel_id: tg, username: `c${tg}_${nonce}` });
  };
  const absent = await mkCh();
  const succeeded = await mkCh();
  const runningLive = await mkCh();
  const runningExpired = await mkCh();
  const failed = await mkCh();
  const queued = await mkCh();
  const disabled = await mkCh();
  const createdKeys = [];
  const claim = async (chId) => {
    createdKeys.push(`${chId}:${day}`);
    return db.claimJob('qr_collect', `${chId}:${day}`);
  };

  const jSucc = await claim(succeeded.id); await db.completeJob(jSucc.id, { ok: true });
  await claim(runningLive.id);                                   // running, lease still alive → excluded
  const jExp = await claim(runningExpired.id);
  await pool.query(`UPDATE jobs SET locked_until = now() - interval '1 hour' WHERE id=$1`, [jExp.id]);
  const jFail = await claim(failed.id); await db.failJob(jFail.id, new Error('boom'));
  createdKeys.push(`${queued.id}:${day}`);
  await pool.query(`INSERT INTO jobs (kind, idempotency_key, status) VALUES ('qr_collect', $1, 'queued')`, [`${queued.id}:${day}`]);
  await pool.query(`UPDATE channels SET status='disabled' WHERE id=$1`, [disabled.id]);

  // A non-qr (ig) channel of the same owner must never appear.
  const igCh = await db.createIgChannel({ owner_uid: O.id, username: `igc_${nonce}` });

  // A reauth_required session's qr channel is excluded entirely.
  const R = await mkUser('candr');
  await db.saveTgSession(R.id, { tg_user_id: 901, username: `r_${nonce}`, session_enc: 'enc:r' });
  const rv = (await db.getTgSession(R.id)).session_version;
  await db.recordTgSessionFailure(R.id, rv, { state: 'reauth_required', errorCode: 'session_unauthorized' });
  tg += 1;
  const rCh = await db.createTgChannel({ owner_uid: R.id, tg_channel_id: tg, username: `rc_${nonce}` });
  createdKeys.push(`${rCh.id}:${day}`);

  try {
    const rows = await db.listTgQrCollectCandidates(day, 100);
    const mine = rows.filter((x) => x.owner_uid === O.id || x.owner_uid === R.id);
    const ids = mine.map((x) => x.id);

    assert.ok(ids.includes(absent.id), 'no job row → included');
    assert.ok(ids.includes(runningExpired.id), 'expired-running lease → re-claimable → included');
    assert.ok(ids.includes(failed.id), 'failed → included');
    assert.ok(ids.includes(queued.id), 'queued → included');
    assert.ok(!ids.includes(succeeded.id), 'succeeded → excluded');
    assert.ok(!ids.includes(runningLive.id), 'live-leased running → excluded');
    assert.ok(!ids.includes(disabled.id), 'disabled channel → excluded');
    assert.ok(!ids.includes(igCh.id), 'non-qr channel → excluded');
    assert.ok(!ids.includes(rCh.id), 'reauth_required session channel → excluded');

    // Deterministic order: uid asc, then channel id asc (all `mine` are the same owner → id asc).
    assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b), 'rows are ordered by (uid, channel id)');

    // Secret boundary: exactly the fields collection needs; NEVER the session tg_user_id/username.
    const sample = mine.find((x) => x.id === absent.id);
    assert.ok(['uid', 'session_enc', 'session_version', 'id', 'username', 'tg_channel_id', 'owner_uid', 'source']
      .every((k) => k in sample), 'returns the collection fields');
    assert.strictEqual(sample.session_enc, 'enc:cand', 'encrypted session forwarded (caller decrypts)');
    assert.strictEqual(sample.source, 'qr');
    assert.ok(!('tg_user_id' in sample), 'session tg_user_id is never exposed');
    assert.ok(!('connection_state' in sample), 'session health columns are not exposed');

    // LIMIT is honoured (bound parameter).
    assert.ok((await db.listTgQrCollectCandidates(day, 2)).length <= 2, 'limit caps the page');
  } finally {
    await pool.query(`DELETE FROM jobs WHERE idempotency_key = ANY($1)`, [createdKeys]);
  }
});

test('getCollectorStatus: владелец видит статус, чужой — null (access-предикат)', { skip }, async () => {
  const O = await mkUser('cs');
  const S = await mkUser('cx');
  const ch = await db.createChannel({ owner_uid: O.id, username: `col_${nonce}`, title: 'C' });
  await pool.query(
    `INSERT INTO collector_status (channel_id, collector_version, last_ingest_id, last_attempt_at, last_success_at, last_error)
     VALUES ($1,'1.2.3','ing-1',now(),now(),NULL)`, [ch.id]);
  const st = await db.getCollectorStatus(ch.id, { uid: O.id });
  assert.strictEqual(st.collector_version, '1.2.3');
  assert.strictEqual(st.last_ingest_id, 'ing-1');
  assert.strictEqual(await db.getCollectorStatus(ch.id, { uid: S.id }), null, 'чужой не видит connection-status');
  assert.strictEqual(await db.getCollectorStatus(ch.id, {}), null, 'без uid — null');
});

test('ig_tags: upsert идемпотентен по media_id (свежие счётчики), getIgTags отдаёт архив', { skip }, async () => {
  const m1 = `tag${nonce}_1`;
  await db.upsertIgTags([{ id: m1, username: 'fan', caption: 'hi', like_count: 5, comments_count: 1, timestamp: '2026-01-10T10:00:00Z' }]);
  const n = await db.upsertIgTags([{ id: m1, username: 'fan', caption: 'hi2', like_count: 9, comments_count: 2, timestamp: '2026-01-10T10:00:00Z' }]);
  assert.strictEqual(n, 1);
  const rows = (await db.getIgTags(500)).filter((t) => t.id === m1);
  assert.strictEqual(rows.length, 1, 'один архивный row на media_id (upsert, не дубль)');
  assert.strictEqual(rows[0].caption, 'hi2', 'повторный прогон освежил поля');
  assert.strictEqual(rows[0].like_count, 9);
});
