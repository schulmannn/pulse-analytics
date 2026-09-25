'use strict';

// Контракт data-роутов источника — каркас (программа унификации источников, PR 1.7).
//
// Одна таблица SOURCES, одна строка на источник, и ОДНИ И ТЕ ЖЕ проверки для каждой строки: так
// расхождение между источниками становится красным тестом, а не находкой следующего аудита.
// Роуты собираются настоящими register*Routes и гоняются вместе с их middleware-цепочкой; провайдер
// отвечает через настоящие клиенты (createMtprotoClient, createMsClient) с подменённым fetch, так
// что проверяется весь путь «ответ провайдера → статус и тело роута».
//
// Сейчас в таблице Telegram и МойСклад, и только то, что у обоих держится уже сегодня:
//   • чужой канал → 403 на КАЖДОМ tenant-роуте источника, до любого чтения данных, а владение
//     спрашивается явным id и актором запроса (роуты без канала перечислены поимённо, с причиной);
//   • кривой период → 400 до чтения данных;
//   • квота провайдера → 503 + Retry-After и retry_after в теле, а не 429 и не 401;
//   • сбой провайдера → 5xx, а не 401 (выход из Atlavue) и не 200 с пустыми данными.
// Для МойСклада дополнительно: отзыв токена отдаёт 401 только с кодом из allow-list фронта
// (SOURCE_ACCESS_CODES в frontend/src/lib/authRedirect.ts), иначе фронт уводит на /login.
//
// TODO(2.x): строки Instagram, Яндекс.Метрики, СДЭКа и Rusender — по мере перевода источника на
//   общий разбор периода и makeSourceRead.
// TODO(2.7): отзыв у Telegram — сегодня mtproto 401 (сессия) уходит 401 без кода и разлогинивает;
//   после единого sendSourceError строка «отзыв» станет общей: 409 source_reauth, никогда 401.
// TODO(2.7, 2.11–2.12): 400 bad_period с кодом, 404 source_not_connected, 503 db_unavailable,
//   окно from/to в ответе, previous_window/meta.as_of/completeness и num/den у ratio-рядов,
//   общая форма /status — строки guardrail'а, которых сегодня нет ни у одного источника.
// Каркас работает на фейках без Postgres; SQL-предикаты владения (ForActor) остаются за
// integration-суитами репозиториев.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { registerTgRoutes } = require('../server/routes/tg');
const { registerHistoryRoutes } = require('../server/routes/history');
const { registerMsRoutes } = require('../server/routes/moysklad');
const { makeResolveChannel } = require('../server/middleware/tenant');
const { createMtprotoClient } = require('../server/lib/mtproto-client');
const { createMsClient } = require('../server/lib/msClient');
const { createMemoryCache } = require('../server/infrastructure/memoryCache');

const ACTOR = { uid: 7, role: 'user' };
const OWN = 10;
const FOREIGN = 99;

// ── Обвязка ─────────────────────────────────────────────────────────────────────────────────────

function recordingApp() {
  const routes = new Map();
  const add = (method) => (route, ...handlers) => routes.set(`${method} ${route}`, handlers);
  return { routes, app: { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') } };
}

/** Прогон цепочки как в Express: следующий обработчик — только если предыдущий позвал next(). */
async function run(handlers, { query = {} } = {}) {
  const req = { query, headers: {}, params: { id: '5' }, body: {}, user: ACTOR };
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
    type() { return this; },
    end() { return this; },
  };
  for (const handler of handlers) {
    let advanced = false;
    let failure = null;
    await handler(req, res, (e) => { advanced = true; failure = e ?? null; });
    if (failure) throw failure;
    if (!advanced) break;
  }
  return res;
}

/**
 * БД, которая отдаёт только перечисленное. Любой другой метод — tenant-чтение, и оно
 * записывается и падает: так «до проверки владения данные не читаются» проверяется поимённо.
 */
function strictDb(allowed, touched) {
  return new Proxy(allowed, {
    get(target, prop) {
      if (prop in target || typeof prop === 'symbol') return target[prop];
      return () => {
        touched.push(String(prop));
        throw new Error(`db.${String(prop)}: чтение, которого контракт здесь не ждёт`);
      };
    },
  });
}

/** Ответ провайдера в форме, которую читают оба клиента (Response-подобный объект). */
function upstream(status, body, headers = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  });
}
// Таймаут, а не обрыв соединения: обрыв mtproto-клиент дважды повторяет с паузой, таймаут — нет.
const unreachable = async () => {
  const e = new Error('network timeout');
  e.name = 'FetchError';
  e.type = 'request-timeout';
  throw e;
};
const noUpstream = async () => {
  throw new Error('провайдер не должен вызываться');
};

// ── Источники ───────────────────────────────────────────────────────────────────────────────────

const SOURCES = [
  {
    name: 'Telegram',
    build({ db, fetchImpl = noUpstream }) {
      const { routes, app } = recordingApp();
      const pass = (_req, _res, next) => next();
      const resolveChannel = makeResolveChannel({ db, isReady: () => true });
      const mtprotoClient = createMtprotoClient({ url: 'http://mtproto.test', token: 'test' }, { fetchImpl });
      registerTgRoutes({
        app,
        requireAuth: pass,
        resolveChannel,
        db,
        audit: async () => {},
        log: () => {},
        cacheGet: () => null,
        cacheSet: () => {},
        asyncHandler: (fn) => fn,
        tgCrypto: { configured: () => false },
        mediaLimiter: pass,
        fetchWithTimeout: noUpstream,
        collectQrChannelsNow: async () => [],
        collectManagedPostStatsNow: undefined,
        TG_TOKEN: '',
        TG_CHANNEL: '@test',
        mtprotoClient,
      });
      registerHistoryRoutes({ app, requireAuth: pass, resolveChannel, db, log: () => {} });
      return routes;
    },
    /** Роуты без канала арендатора — поимённо и с причиной. */
    untenanted: {
      'GET /api/tg/qr/status': 'QR-сессия самого пользователя, не канал',
      'POST /api/tg/qr/start': 'QR-вход пользователя',
      'POST /api/tg/qr/poll': 'QR-вход пользователя',
      'POST /api/tg/qr/password': 'QR-вход пользователя',
      'POST /api/tg/qr/cancel': 'QR-вход пользователя',
      'DELETE /api/tg/qr/session': 'отключение собственной QR-сессии',
      'POST /api/tg/qr/channels': 'заводит каналы из собственной QR-сессии, дедуп по своим каналам',
      'GET /api/tg/mtproto/health': 'здоровье сервиса, данных канала нет',
      'GET /api/tg/mtproto/thumb/:id': 'открытый медиа-прокси публичного центрального канала (<img src>)',
      'GET /api/tg/mtproto/channel/photo': 'открытый медиа-прокси публичного центрального канала (<img src>)',
    },
    ownChannel: { id: OWN, owner_uid: ACTOR.uid, source: 'central', member_role: 'owner' },
    /** Роуты, принимающие точное окно from/to: кривое окно у них — 400. */
    periodRoutes: ['GET /api/history/mentions'],
    /** Живой data-роут: провайдер отвечает сам, снапшота центрального канала нет. */
    live: { route: 'GET /api/tg/mtproto/stats', query: {}, db: { getSnapshotInternal: async () => null } },
    throttle: upstream(429, { detail: 'flood_wait', retry_after: 42 }),
    throttleRetryAfter: 42,
    revoked: null, // TODO(2.7): см. шапку
  },
  {
    name: 'МойСклад',
    build({ db, fetchImpl = noUpstream }) {
      const { routes, app } = recordingApp();
      const pass = (_req, _res, next) => next();
      const cache = createMemoryCache({});
      registerMsRoutes({
        app,
        requireAuth: pass,
        db,
        audit: async () => {},
        msCrypto: { configured: () => true, decrypt: () => 'TOKEN', encrypt: (t) => `enc(${t})` },
        msFetch: createMsClient({ fetchImpl }).msFetch,
        msBackfill: { isBusy: async () => false, start: () => Promise.resolve({}) },
        cacheGet: cache.get,
        cacheSet: cache.set,
        cache,
        log: () => {},
        sleepFn: async () => {},
      });
      return routes;
    },
    untenanted: {
      'POST /api/ms/connect': 'подключение по токену создаёт канал вызывающего или находит его же — чужой канал не читается',
    },
    ownChannel: { id: OWN, owner_uid: ACTOR.uid, member_role: 'owner' },
    periodRoutes: [
      'GET /api/ms/summary',
      'GET /api/ms/top-products',
      'GET /api/ms/stock',
      'GET /api/ms/top-customers',
      'GET /api/ms/sales-by-channel',
      'GET /api/ms/geography',
      'GET /api/ms/channel-series',
      'GET /api/ms/funnel',
      'GET /api/ms/customers',
      'GET /api/ms/rfm',
      'GET /api/ms/rfm-customers',
      'GET /api/ms/returns',
    ],
    live: {
      route: 'GET /api/ms/summary',
      query: { days: '30' },
      db: { getMsAccount: async () => ({ access_token_enc: 'enc', org_name: 'ООО Ромашка' }) },
    },
    // Заголовок паузы 0: клиент МС один раз повторяет 429, и тест не должен спать по-настоящему.
    throttle: upstream(429, { errors: [{ error: 'Превышен лимит' }] }, { 'x-lognex-retry-after': '0' }),
    throttleRetryAfter: 0,
    revoked: upstream(401, { errors: [{ error: 'Ошибка аутентификации' }] }),
  },
];

/** Параметры, с которыми любой роут дошёл бы до разбора канала (валидный сегмент, пресет окна). */
const VALID_QUERY = { days: '30', segment: 'champions' };

// ── Контракт ────────────────────────────────────────────────────────────────────────────────────

for (const source of SOURCES) {
  test(`${source.name}: чужой канал → 403 на каждом tenant-роуте, до любого чтения данных`, async () => {
    const touched = [];
    const asked = [];
    const db = strictDb(
      {
        enabled: true,
        getChannelOrDefault: async (id, actor) => {
          asked.push({ id, uid: actor?.uid });
          return id === OWN ? source.ownChannel : null;
        },
      },
      touched,
    );
    const routes = source.build({ db });

    for (const key of Object.keys(source.untenanted)) {
      assert.ok(routes.has(key), `${source.name}: исключение «${key}» указывает на роут, которого нет`);
    }
    const tenanted = [...routes.keys()].filter((key) => !(key in source.untenanted));
    assert.ok(tenanted.length >= 5, `${source.name}: таблица роутов подозрительно пуста: ${tenanted.join(', ')}`);

    for (const key of tenanted) {
      asked.length = 0;
      const res = await run(routes.get(key), { query: { ...VALID_QUERY, channel: String(FOREIGN) } });
      assert.equal(res.statusCode, 403, `${key}: чужой канал обязан давать 403, а не ${res.statusCode}`);
      assert.deepEqual(asked, [{ id: FOREIGN, uid: ACTOR.uid }], `${key}: владение спрашивается явным id и актором`);
    }
    assert.deepEqual(touched, [], `${source.name}: данные читались до проверки владения`);
  });

  test(`${source.name}: кривой период → 400 до чтения данных`, async () => {
    const touched = [];
    const db = strictDb({ enabled: true, getChannelOrDefault: async () => source.ownChannel }, touched);
    const routes = source.build({ db });
    for (const key of source.periodRoutes) {
      assert.ok(routes.has(key), `${key}: роута нет`);
      for (const bad of [{ from: '2026-02-31', to: '2026-03-10' }, { from: '2026-03-10', to: '2026-03-01' }]) {
        const res = await run(routes.get(key), { query: { ...VALID_QUERY, ...bad } });
        assert.equal(res.statusCode, 400, `${key} ${JSON.stringify(bad)}: ожидался 400, а не ${res.statusCode}`);
        assert.equal(typeof res.body.error, 'string', `${key}: у 400 есть человеческое сообщение`);
      }
    }
    assert.deepEqual(touched, [], `${source.name}: кривое окно дошло до чтения данных`);
  });

  test(`${source.name}: квота провайдера → 503 + Retry-After и retry_after, а не 429/401`, async () => {
    const db = strictDb({ enabled: true, getChannelOrDefault: async () => source.ownChannel, ...source.live.db }, []);
    const routes = source.build({ db, fetchImpl: source.throttle });
    const res = await run(routes.get(source.live.route), { query: source.live.query });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['Retry-After'], String(source.throttleRetryAfter));
    assert.equal(res.body.retry_after, source.throttleRetryAfter);
    assert.equal(typeof res.body.error, 'string');
  });

  test(`${source.name}: провайдер недоступен → 5xx, а не 401 и не 200 с пустыми данными`, async () => {
    const db = strictDb({ enabled: true, getChannelOrDefault: async () => source.ownChannel, ...source.live.db }, []);
    const routes = source.build({ db, fetchImpl: unreachable });
    const res = await run(routes.get(source.live.route), { query: source.live.query });
    assert.ok(res.statusCode >= 500 && res.statusCode < 600, `${source.live.route}: ${res.statusCode}`);
    assert.equal(typeof res.body.error, 'string');
  });

  if (source.revoked) {
    test(`${source.name}: отзыв доступа у провайдера — 401 только с кодом из allow-list фронта`, async () => {
      const db = strictDb({ enabled: true, getChannelOrDefault: async () => source.ownChannel, ...source.live.db }, []);
      const routes = source.build({ db, fetchImpl: source.revoked });
      const res = await run(routes.get(source.live.route), { query: source.live.query });
      if (res.statusCode === 401) {
        assert.ok(
          sourceAccessCodes().has(res.body.code),
          `401 с кодом «${res.body.code}» фронт примет за конец сессии Atlavue и уведёт на /login`,
        );
      } else {
        assert.equal(res.statusCode, 409, `отзыв — это 401 с кодом источника сегодня или 409 после 2.7, а не ${res.statusCode}`);
      }
    });
  }
}

/** SOURCE_ACCESS_CODES фронта — читаются из исходника: список один, второй копии здесь нет. */
function sourceAccessCodes() {
  const file = path.join(__dirname, '..', 'frontend', 'src', 'lib', 'authRedirect.ts');
  const text = fs.readFileSync(file, 'utf8');
  const m = /SOURCE_ACCESS_CODES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(text);
  assert.ok(m, 'SOURCE_ACCESS_CODES не найден в frontend/src/lib/authRedirect.ts — контракт отзыва потерян');
  return new Set([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
}

test('allow-list кодов отзыва фронта читается и не пуст', () => {
  const codes = sourceAccessCodes();
  assert.ok(codes.has('ms_token_revoked'));
  assert.ok(codes.has('source_reauth'));
});
