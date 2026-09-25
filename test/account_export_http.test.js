'use strict';

// GET /api/account/export по НАСТОЯЩЕМУ HTTP: express + compression() смонтирован глобально до
// роутов, как в server/app.js, реальный gdprService, фейковый pg-пул. Юнит-тесты гоняют экспорт
// через фейковый res и не видят того, что делает с ответом compression, — отсюда аудит #554:
//   • GDPR-1: браузер всегда шлёт Accept-Encoding: gzip/br; compression подменяет res.end(chunk)
//     и принимал колбэк writer'а за данные → TypeError на финале, соединение рвалось, аудита нет.
//     Здесь: gzip/br/identity → 200, распакованное тело — валидный JSON, аудит ровно один раз.
//   • GDPR-2/DB-4: клиент, который не читает ответ, держал коннект основного пула вечно. Здесь:
//     сторож drain рвёт такую выгрузку и возвращает коннект; сверх лимита одновременных выгрузок
//     роут отвечает 503 + Retry-After с русским текстом ДО первого байта.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const express = require('express');
const compression = require('compression');
const { registerAccountRoutes } = require('../server/routes/account');
const { createGdprService } = require('../server/services/gdprService');

/**
 * Фейковый pg-пул: у каждого uid есть аккаунт и (при `endless`) один канал с бесконечным
 * архивом channel_daily — страница за страницей широких строк, пока экспорт не прервут.
 * `gate` (Promise) придерживает запрос аккаунта — так выгрузка «висит» внутри лимита.
 */
function fakePool({ gate = null, endless = false } = {}) {
  const state = { connects: 0, released: 0, dailyPages: 0 };
  state.connect = async () => {
    state.connects += 1;
    const client = new EventEmitter();
    client.query = async (sql, params) => {
      if (/FROM users WHERE id=\$1/.test(sql)) {
        if (gate) await gate;
        return { rows: [{ id: params[0], email: `u${params[0]}@x.test`, role: 'user', status: 'active', avatar_url: null, created_at: new Date(0) }] };
      }
      if (endless && /FROM channels WHERE owner_uid/.test(sql)) {
        return { rows: params.length === 2 ? [{ id: 9, workspace_id: null, username: 'c', title: 'Канал', status: 'active', source: 'collector', tg_channel_id: null, created_at: new Date(0) }] : [] };
      }
      if (endless && /FROM channel_daily/.test(sql)) {
        state.dailyPages += 1;
        const base = state.dailyPages * 1000;
        // Случайный hex почти не сжимается — буферы сокета/zlib заполняются за пару страниц.
        return {
          rows: Array.from({ length: 1000 }, (_, i) => ({
            day: String(base + i), pad: crypto.randomBytes(1024).toString('hex'), __c0: String(base + i),
          })),
        };
      }
      return { rows: [] };
    };
    client.release = () => { state.released += 1; };
    return client;
  };
  return state;
}

/** Приложение как в server/app.js: compression() глобально, затем account-роуты. Сервер
 *  закрывается в t.after — и на таймауте теста (зависшая выгрузка не держит процесс). */
async function startApp(t, gdprOptions = {}, poolOptions = {}) {
  const pool = fakePool(poolOptions);
  const gdpr = createGdprService({ pool, enabled: true, transaction: null, ...gdprOptions });
  const audits = [];
  const app = express();
  app.use(compression());
  registerAccountRoutes({
    app,
    requireAuth(req, _res, next) {
      req.user = { uid: Number(req.get('x-test-uid') || 7), role: 'user', email: 'u@x.test' };
      next();
    },
    requireSuper: (_req, _res, next) => next(),
    db: { enabled: true, streamUserExport: gdpr.streamUserExport },
    audit: async (req, action) => { audits.push({ uid: req.user.uid, action }); },
    sendEmail: async () => {},
    emailShell: () => '',
    GOOGLE_CLIENT_ID: null,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { pool, audits, port: server.address().port };
}

/** GET с заданным Accept-Encoding; тело распаковывается по Content-Encoding ответа. */
function getExport(port, { encoding = 'identity', uid = 7 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/api/account/export', agent: false,
      headers: { 'accept-encoding': encoding, 'x-test-uid': String(uid) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const ce = res.headers['content-encoding'];
        let body = raw;
        if (ce === 'gzip') body = zlib.gunzipSync(raw);
        else if (ce === 'br') body = zlib.brotliDecompressSync(raw);
        resolve({ status: res.statusCode, headers: res.headers, text: body.toString('utf8') });
      });
    });
    req.on('error', reject);
  });
}

async function waitFor(cond, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

for (const [encoding, expected] of [
  ['gzip', 'gzip'],
  ['br', 'br'],
  ['gzip, deflate, br', 'br'], // как шлёт браузер: compression выбирает br
  ['identity', undefined],
]) {
  test(`HTTP-экспорт под compression: Accept-Encoding «${encoding}» → 200, валидный JSON, аудит один раз`, { timeout: 10000 }, async (t) => {
    const { pool, audits, port } = await startApp(t);
    const res = await getExport(port, { encoding }); // до правки: ECONNRESET на финальном res.end
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], expected);
    assert.match(res.headers['content-disposition'], /^attachment; filename="atlavue-export-/);
    const doc = JSON.parse(res.text);
    assert.equal(doc.format, 'atlavue-export');
    assert.equal(doc.account.id, 7);
    assert.deepEqual(doc.channels, []);
    await waitFor(() => audits.length > 0, 'аудит account.exported');
    assert.deepEqual(audits, [{ uid: 7, action: 'account.exported' }], 'аудит ровно один раз');
    assert.equal(pool.released, pool.connects, 'коннект возвращён в пул');
  });
}

for (const encoding of ['gzip', 'identity']) {
  test(`HTTP-экспорт: клиент не читает ответ (${encoding}) → сторож drain рвёт выгрузку и возвращает коннект`, { timeout: 15000 }, async (t) => {
    const warns = [];
    t.mock.method(console, 'warn', (...a) => { warns.push(a.join(' ')); });
    const { pool, audits, port } = await startApp(t, { exportDrainTimeoutMs: 200 }, { endless: true });
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    t.after(() => sock.destroy());
    await new Promise((resolve) => sock.once('connect', resolve));
    sock.write(`GET /api/account/export HTTP/1.1\r\nHost: x\r\nAccept-Encoding: ${encoding}\r\nConnection: close\r\n\r\n`);
    sock.pause(); // ни байта не читаем: буферы заполняются, res.write → false, 'drain' не придёт
    await waitFor(() => pool.connects === 1 && pool.released === 1,
      'коннект основного пула возвращён (до правки выгрузка висела на drain вечно)', 10000);
    assert.equal(audits.length, 0, 'оборванная выгрузка не аудитится');
    assert.ok(warns.some((w) => w.includes('export stalled')), 'обрыв по сторожу залогирован');
    const pagesAtAbort = pool.dailyPages;
    // Сервер разорвал соединение: дочитав буфер, клиент получает конец потока.
    const closed = new Promise((resolve) => sock.once('close', resolve));
    sock.resume();
    await closed;
    assert.equal(pool.dailyPages, pagesAtAbort, 'после обрыва в БД больше не ходим');
  });
}

test('HTTP-экспорт: сверх лимита одновременных выгрузок → 503 + Retry-After до первого байта', { timeout: 10000 }, async (t) => {
  let open;
  const gate = new Promise((r) => { open = r; });
  t.after(() => open());
  const { pool, audits, port } = await startApp(t, { exportMaxConcurrent: 2 }, { gate });
  const first = getExport(port, { encoding: 'gzip', uid: 1 });
  const second = getExport(port, { encoding: 'gzip', uid: 2 });
  // Хендлеры сразу: если тест упадёт раньше await, обрыв на закрытии сервера не станет
  // unhandledRejection.
  first.catch(() => {});
  second.catch(() => {});
  await waitFor(() => pool.connects === 2, 'две выгрузки заняли слоты');

  for (const uid of [3, 1]) { // чужая третья и повторная своя
    const busy = await getExport(port, { encoding: 'gzip, deflate, br', uid });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers['retry-after'], '60');
    assert.equal(busy.headers['content-disposition'], undefined, 'заголовков файла нет — это не выгрузка');
    const body = JSON.parse(busy.text);
    assert.equal(body.error, 'Сейчас уже идёт выгрузка данных — попробуйте через минуту');
    assert.equal(body.retry_after, 60);
  }
  assert.equal(pool.connects, 2, 'отклонённые выгрузки коннект не брали');

  open();
  const done = await Promise.all([first, second]);
  for (const res of done) {
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).format, 'atlavue-export');
  }
  await waitFor(() => audits.length === 2, 'аудит обеих завершённых выгрузок');
  assert.deepEqual(audits.map((a) => a.uid).sort(), [1, 2]);
  // Слоты освобождены — следующая выгрузка проходит.
  assert.equal((await getExport(port, { encoding: 'gzip', uid: 3 })).status, 200);
});
