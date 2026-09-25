'use strict';

// Integration-тесты архива Instagram (OD-13) на РЕАЛЬНОМ Postgres: миграция 042 (ig_backfill_state),
// репозиторий состояния догрузки (allow-list, heartbeat, кандидаты), статус дней архива, страж
// идентичности upsertIgDaily и ридеры архива (формы окна, страж идентичности, гейт владения).
// Без TEST_DATABASE_URL всё SKIP. Даты — от якоря прогона (test/helpers/dates).
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createTestDatabase } = require('./testDatabase');
const { anchor, dayKey } = require('./helpers/dates');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `igarc${Date.now().toString(36)}${process.pid}`;
let seq = 0;
const mail = (tag) => `${tag}.${seq++}.${nonce}@it.local`;
const usedIg = [];
let igSeq = 0;
const igId = () => { const v = `ig${nonce}_${igSeq++}`; usedIg.push(v); return v; };
const T = anchor();
const d = (n) => dayKey(T, -n);

const mkUser = (tag) => db.createUser({ email: mail(tag), pass_hash: 'x', role: 'user', status: 'active' });
async function mkIgChannel(tag) {
  const owner = await mkUser(tag);
  const ch = await db.createIgChannel({ owner_uid: owner.id, username: `${tag}_${nonce}` });
  const ig = igId();
  await db.saveIgAccount(ch.id, { ig_user_id: ig, username: tag, access_token_enc: 'enc:x', token_expires_at: null, scopes: 's' });
  return { owner, ch, ig };
}
const actor = (u) => ({ uid: u.id, role: 'user' });

test.before(() => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM external_sources WHERE external_id = ANY($1)`, [usedIg]);
  await pool.end();
  await db.close();
});

test('миграция 042 идемпотентна: повторное применение — без ошибок, схема на месте', { skip }, async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'server', 'migrations', '042_ig_backfill_state.sql'), 'utf8');
  await pool.query(sql);
  await pool.query(sql);
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='ig_backfill_state' ORDER BY column_name`);
  const cols = rows.map((r) => r.column_name);
  for (const c of ['channel_id', 'ig_user_id', 'status', 'cursor_day', 'floor_day', 'horizon_day', 'empty_streak',
    'day_attempts', 'days_fetched', 'days_with_data', 'calls_day', 'calls_count', 'error', 'started_at', 'finished_at', 'updated_at']) {
    assert.ok(cols.includes(c), `колонка ${c}`);
  }
  assert.ok(!cols.includes('source_id'), 'операционная таблица без source_id (GDPR orphan-sweep не задет)');
});

test('состояние догрузки: allow-list, частичный upsert, heartbeat, CHECK статуса, каскад с каналом', { skip }, async () => {
  const { ch, ig } = await mkIgChannel('st');
  assert.strictEqual(await db.getIgBackfillState(ch.id), null);
  assert.strictEqual(await db.setIgBackfillState(ch.id, { status: 'running' }), false, 'чекпойнт без строки ничего не создаёт');
  await db.setIgBackfillState(ch.id, { ig_user_id: ig, status: 'running', cursor_day: d(2), floor_day: d(732), calls_day: d(0), calls_count: 11, evil: 'x' });
  const s1 = await db.getIgBackfillState(ch.id);
  assert.strictEqual(s1.ig_user_id, ig);
  assert.strictEqual(s1.cursor_day, d(2), 'дата строкой YYYY-MM-DD');
  assert.strictEqual(s1.calls_count, 11);
  assert.strictEqual(s1.evil, undefined, 'неизвестный ключ патча в SQL не попадает');
  assert.ok(Number.isFinite(new Date(s1.updated_at).getTime()), 'момент с TZH:TZM разбирается JS-Date');
  await pool.query(`UPDATE ig_backfill_state SET updated_at = now() - interval '1 hour' WHERE channel_id=$1`, [ch.id]);
  assert.strictEqual(await db.setIgBackfillState(ch.id, { horizon_day: d(40), error: 'x'.repeat(500) }), true, 'частичный чекпойнт без ig_user_id');
  const s2 = await db.getIgBackfillState(ch.id);
  assert.strictEqual(s2.cursor_day, d(2), 'неприсланные ключи не тронуты');
  assert.strictEqual(s2.horizon_day, d(40));
  assert.strictEqual(s2.error.length, 200, 'код ошибки обрезан');
  assert.ok(s2.updated_age_seconds < 60, 'heartbeat: updated_at штампуется каждой записью');
  await assert.rejects(db.setIgBackfillState(ch.id, { status: 'bogus' }), /check|violates/i);
  await pool.query('DELETE FROM channels WHERE id=$1', [ch.id]);
  const gone = await pool.query('SELECT 1 FROM ig_backfill_state WHERE channel_id=$1', [ch.id]);
  assert.strictEqual(gone.rows.length, 0, 'удаление канала каскадом сносит состояние');
});

test('кандидаты догрузки: порядок, чужая идентичность, error через сутки или после reconnect, done — в ремонт', { skip }, async () => {
  const fresh = await mkIgChannel('cf');     // нет состояния
  const running = await mkIgChannel('cr');
  const done = await mkIgChannel('cd');
  const errOld = await mkIgChannel('ceo');
  const errNew = await mkIgChannel('cen');
  const errReconn = await mkIgChannel('cer');
  const foreign = await mkIgChannel('cfo');
  await db.setIgBackfillState(running.ch.id, { ig_user_id: running.ig, status: 'running' });
  await db.setIgBackfillState(done.ch.id, { ig_user_id: done.ig, status: 'done', horizon_day: d(90) });
  await db.setIgBackfillState(errOld.ch.id, { ig_user_id: errOld.ig, status: 'error', error: 'ig_reauth' });
  await db.setIgBackfillState(errNew.ch.id, { ig_user_id: errNew.ig, status: 'error', error: 'ig_reauth' });
  await db.setIgBackfillState(errReconn.ch.id, { ig_user_id: errReconn.ig, status: 'error', error: 'ig_reauth' });
  await db.setIgBackfillState(foreign.ch.id, { ig_user_id: 'someone-else', status: 'done' });
  await pool.query(`UPDATE ig_backfill_state SET updated_at = now() - interval '25 hours' WHERE channel_id=$1`, [errOld.ch.id]);
  await pool.query(`UPDATE ig_backfill_state SET updated_at = now() - interval '2 hours' WHERE channel_id=$1`, [running.ch.id]);
  await pool.query(`UPDATE ig_backfill_state SET updated_at = now() - interval '1 hour' WHERE channel_id=$1`, [errReconn.ch.id]);
  await pool.query(`UPDATE ig_accounts SET updated_at = now() WHERE channel_id=$1`, [errReconn.ch.id]);   // reconnect
  const mine = new Set([fresh, running, done, errOld, errNew, errReconn, foreign].map((x) => x.ch.id));
  const list = (await db.listIgBackfillCandidates(1000)).filter((r) => mine.has(r.channel_id));
  const ids = list.map((r) => r.channel_id);
  assert.strictEqual(ids[0], fresh.ch.id, 'без состояния — первым (NULLS FIRST)');
  assert.ok(ids.includes(running.ch.id));
  assert.ok(ids.includes(errOld.ch.id), 'ошибка старше суток — снова кандидат');
  assert.ok(ids.includes(errReconn.ch.id), 'после переподключения — снова кандидат');
  assert.ok(ids.includes(foreign.ch.id), 'состояние чужой идентичности — проход заново');
  assert.ok(!ids.includes(errNew.ch.id), 'свежая ошибка ждёт');
  assert.ok(!ids.includes(done.ch.id), 'done в обход не берётся');
  assert.ok(ids.indexOf(errOld.ch.id) < ids.indexOf(running.ch.id), 'давнее — раньше');
  assert.ok(list.every((r) => typeof r.access_token_enc === 'string'), 'токен отдаётся шифрованным для доверенного прохода');
  const heal = (await db.listIgHealCandidates(1000)).filter((r) => mine.has(r.channel_id));
  assert.deepStrictEqual(heal.map((r) => r.channel_id), [done.ch.id], 'ремонт — только done своей идентичности');
  assert.strictEqual(heal[0].horizon_day, d(90));
});

test('статус дней и страж идентичности upsert: чужой день занят и не перезаписывается; крон — прежний SQL', { skip }, async () => {
  const { ch, ig } = await mkIgChannel('ds');
  await db.upsertIgDaily(ch.id, [
    { day: d(3), reach: 10 },
    { day: d(4), total_interactions: 2 },           // неполный: нет ни reach, ни views
    { day: d(5), followers_total: 500 },            // строка без дневных данных
  ]);
  // Чужой день: source_id другого аккаунта (как после переподключения другого IG).
  const other = await pool.query(`INSERT INTO external_sources (network, external_id) VALUES ('ig', $1) RETURNING id`, [igId()]);
  await pool.query(`INSERT INTO ig_daily (channel_id, source_id, day, reach) VALUES ($1, $2, $3, NULL)`, [ch.id, other.rows[0].id, d(6)]);
  const st = Object.fromEntries((await db.listIgDayStatus(ch.id, d(7), d(2))).map((r) => [r.day, r]));
  assert.deepStrictEqual(st[d(3)], { day: d(3), occupied: true, incomplete: false });
  assert.deepStrictEqual(st[d(4)], { day: d(4), occupied: true, incomplete: true });
  assert.deepStrictEqual(st[d(5)], { day: d(5), occupied: false, incomplete: true });
  assert.deepStrictEqual(st[d(6)], { day: d(6), occupied: true, incomplete: false }, 'чужой день занят — вызовы на него не тратим');
  assert.strictEqual(st[d(2)], undefined, 'дня без строки в статусе нет');

  const n = await db.upsertIgDaily(ch.id, [{ day: d(6), reach: 99 }], undefined, { guardSource: true, igUserId: ig });
  assert.strictEqual(n, 0, 'guardSource отказал чужой строке');
  const foreign = await pool.query(`SELECT reach, source_id FROM ig_daily WHERE channel_id=$1 AND day=$2`, [ch.id, d(6)]);
  assert.strictEqual(foreign.rows[0].reach, null);
  assert.strictEqual(foreign.rows[0].source_id, other.rows[0].id);

  const m = await db.upsertIgDaily(ch.id, [{ day: d(5), reach: 7 }], undefined, { guardSource: true, igUserId: ig });
  assert.strictEqual(m, 1, 'своя строка дополняется');
  const own = await pool.query(`SELECT reach, followers_total FROM ig_daily WHERE channel_id=$1 AND day=$2`, [ch.id, d(5)]);
  assert.strictEqual(Number(own.rows[0].reach), 7);
  assert.strictEqual(Number(own.rows[0].followers_total), 500, 'null в строке бэкфилла не стирает якорь крона');

  const stale = await db.upsertIgDaily(ch.id, [{ day: d(8), reach: 1 }], undefined, { guardSource: true, igUserId: 'not-connected-anymore' });
  assert.strictEqual(stale, 0, 'данные снятые токеном прежней идентичности не записываются');
  assert.strictEqual((await pool.query(`SELECT 1 FROM ig_daily WHERE channel_id=$1 AND day=$2`, [ch.id, d(8)])).rows.length, 0);

  // Крон без opts — прежняя семантика: новое не-null перезаписывает и чужую строку.
  await db.upsertIgDaily(ch.id, [{ day: d(6), reach: 42 }]);
  const cron = await pool.query(`SELECT reach FROM ig_daily WHERE channel_id=$1 AND day=$2`, [ch.id, d(6)]);
  assert.strictEqual(Number(cron.rows[0].reach), 42);
});

test('архив: «Всё», точный диапазон и legacy days; страж идентичности при reconnect/disconnect; гейт владения', { skip }, async () => {
  const { owner, ch, ig } = await mkIgChannel('ar');
  const rows = [];
  for (const n of [800, 500, 100, 30, 3]) rows.push({ day: d(n), reach: n, views: n * 2 });
  await db.upsertIgDaily(ch.id, rows);
  await db.upsertIgDaily(ch.id, [{ day: d(2), followers_total: 10 }]);   // без дневных данных

  const all = await db.listIgDailyInternal(ch.id, { all: true });
  assert.deepStrictEqual(all.map((r) => r.day), [d(800), d(500), d(100), d(30), d(3), d(2)], '«Всё» без нижней границы (OD-13)');
  assert.strictEqual(all[0].reach, 800, 'BIGINT-счётчики числами');
  assert.strictEqual(all[5].reach, null, 'пропуск — null, не 0');
  const range = await db.listIgDailyInternal(ch.id, { from: d(600), to: d(30) });
  assert.deepStrictEqual(range.map((r) => r.day), [d(500), d(100), d(30)], 'границы включительно');
  const legacy = await db.listIgDailyInternal(ch.id, 400);
  assert.deepStrictEqual(legacy.map((r) => r.day), [d(100), d(30), d(3), d(2)], 'legacy: day >= CURRENT_DATE - n');

  const status = await db.getIgArchiveStatusForActor(ch.id, actor(owner));
  assert.deepStrictEqual(status.bounds, { first_day: d(800), last_day: d(3) }, 'границы — по дням с данными');
  assert.strictEqual(status.measured_days, 5);
  assert.deepStrictEqual(status.backfill, { status: 'idle', horizon_day: null, cursor_day: null, reason: null },
    'аккаунт подключён, догрузка ещё не бралась — ожидает');
  const stranger = await mkUser('stranger');
  assert.deepStrictEqual(await db.listIgDailyForActor(ch.id, actor(stranger), { all: true }), []);
  assert.strictEqual(await db.getIgArchiveStatusForActor(ch.id, actor(stranger)), null);
  assert.strictEqual((await db.listIgDailyForActor(ch.id, actor(owner), { all: true })).length, 6);

  await db.setIgBackfillState(ch.id, { ig_user_id: ig, status: 'error', error: 'ig_reauth', horizon_day: d(800), cursor_day: d(801) });
  assert.deepStrictEqual((await db.getIgArchiveStatusInternal(ch.id)).backfill,
    { status: 'error', horizon_day: d(800), cursor_day: d(801), reason: 'ig_reauth' });

  // Reconnect ДРУГОГО аккаунта: строки прежнего скрыты, статус догрузки — «начнётся заново».
  const ig2 = igId();
  await db.saveIgAccount(ch.id, { ig_user_id: ig2, username: 'other', access_token_enc: 'enc:y', token_expires_at: null, scopes: 's' });
  assert.deepStrictEqual(await db.listIgDailyInternal(ch.id, { all: true }), [], 'чужая история не выдаётся за новую');
  const st2 = await db.getIgArchiveStatusInternal(ch.id);
  assert.strictEqual(st2.bounds, null);
  assert.deepStrictEqual(st2.backfill, { status: 'idle', horizon_day: null, cursor_day: null, reason: null });

  // Disconnect: строки ig_accounts нет — архив канала читается целиком.
  await db.deleteIgAccount(ch.id);
  assert.strictEqual((await db.listIgDailyInternal(ch.id, { all: true })).length, 6);
  const st3 = await db.getIgArchiveStatusInternal(ch.id);
  assert.strictEqual(st3.backfill, null, 'без подключения догрузки нет');
  assert.deepStrictEqual(st3.bounds, { first_day: d(800), last_day: d(3) });
});
