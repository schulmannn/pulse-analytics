'use strict';

const { kopecksToRub } = require('../lib/msClient');
const { hasWorkspaceRole } = require('../middleware/tenant');

/**
 * Роуты МойСклада (/api/ms/{connect,summary,top-products,status,account,backfill,backfill-status})
 * — серверная половина
 * источника «склад», зеркально Instagram-вертикали: connect валидирует токен живыми
 * identity-вызовами и сохраняет его ТОЛЬКО шифрованным (lib/ms_crypto), data-роуты резолвят
 * канал тем же механизмом, что resolveIg (?channel= / заголовок x-channel-id, дефолт через
 * db.getChannelOrDefault — тот же ownership/disabled-предикат), и кэшируются как IG-роуты
 * (дефолтный TTL memoryCache). Все суммы наружу — в РУБЛЯХ (kopecksToRub), внутри МС/БД —
 * копейки. Токен нигде не логируется и не попадает в ответы/сообщения ошибок (msClient держит
 * его только в заголовке запроса). days=0 («Всё») обслуживается ИЗ АРХИВА ms_daily (его копит
 * jobs/msCollectionJob) — живых вызовов МС не делает и токена не требует.
 */
function registerMsRoutes({ app, requireAuth, db, msCrypto, msFetch, msBackfill, cacheGet, cacheSet, cache, log }) {
  // Узкий enum периодов ДО кэш-ключа (как nearestOf у IG): произвольный days плодил бы
  // per-value кэш-записи, каждая ценой пары upstream-запросов. 0 = «Всё» (архив ms_daily,
  // upstream-вызовов нет). Не-enum → дефолт 30.
  const MS_DAYS_ALLOWED = [0, 7, 30, 90];
  const daysOf = (req) => {
    const n = parseInt(req.query.days, 10);
    return MS_DAYS_ALLOWED.includes(n) ? n : 30;
  };
  const MS_TOP_LIMIT_DEFAULT = 10;
  const MS_TOP_LIMIT_MAX = 50;

  // 'YYYY-MM-DD' по местным часам процесса (Railway = UTC) — как остальные дневные окна бэка.
  const fmtDay = (d) => {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };
  // Окно периода: «сегодня-(days-1) 00:00:00» … «сегодня 23:59:00» — границы moment
  // у отчётов МС включительные, day-серия plotseries отдаёт ровно days точек.
  function periodWindow(days) {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    return { momentFrom: `${fmtDay(from)} 00:00:00`, momentTo: `${fmtDay(now)} 23:59:00` };
  }

  // Единый маппинг ошибок msFetch для data-роутов. 429 (уже ПОСЛЕ одной внутренней повторной
  // попытки клиента) → честный 503 с retry-хинтом: у МС жёсткий лимит 45 запросов/3с, «зайди
  // через пару секунд» точнее, чем маскировать под 502. 401/403 от МС = токен отозван/права
  // сняты УЖЕ ПОСЛЕ connect'а — это не «сервис упал», а действие пользователя в МойСкладе:
  // отвечаем 401 + машинный code, чтобы UI показал reconnect-CTA вместо «попробуйте позже».
  // Всё остальное (сеть/5xx) → 502 «МойСклад недоступен». В лог — только path-контекст/статус,
  // никогда токен.
  function sendMsError(res, e, ctx) {
    const status = Number(e && e.status) || 0;
    log('warn', 'ms_fetch_failed', { ...ctx, status, error: e && e.message });
    if (status === 429) {
      if (e.retryAfter != null) res.set('Retry-After', String(e.retryAfter));
      return res.status(503).json({
        error: 'МойСклад ограничил частоту запросов — попробуй через несколько секунд',
        retry_after: e.retryAfter != null ? e.retryAfter : null,
      });
    }
    if (status === 401 || status === 403) {
      return res.status(401).json({
        error: 'Токен отозван МойСкладом — переподключите источник',
        code: 'ms_token_revoked',
      });
    }
    return res.status(502).json({ error: 'МойСклад недоступен' });
  }

  // Точечная инвалидация кэша одного канала (ключи `ms:<kind>:<channelId>[:…]`) — connect и
  // отключение переворачивают UI сразу, не пересиживая 10-минутный TTL. Зеркало igCachePurge:
  // delimiter-aware сравнение слота канала (purge 12 не трогает 123), сбой инвалидации никогда
  // не превращает уже-долговечную мутацию интеграции в ложную ошибку (TTL доберёт).
  function msCachePurge(channelId) {
    if (!channelId) return;
    try {
      if (!cache || typeof cache.keys !== 'function' || typeof cache.delete !== 'function') {
        throw new Error('cache contract has no targeted invalidation');
      }
      const id = String(channelId);
      for (const k of cache.keys()) {
        const parts = k.split(':');
        if (parts[0] === 'ms' && parts[2] === id) cache.delete(k);
      }
    } catch (error) {
      log('warn', 'ms_cache_purge_failed', {
        error: error && error.message ? error.message : 'unknown',
      });
    }
  }

  // Резолв канала запроса + строки ms_accounts БЕЗ расшифровки токена. Канал приходит тем же
  // путём, что у resolveIg: ?channel= / заголовок x-channel-id, при их отсутствии — дефолтный
  // канал пользователя (db.getChannelOrDefault — тот же ownership/disabled-предикат, что
  // getChannel). Явный id без доступа → 403 ВСЕГДА (не раскрываем существование канала, даже
  // для status). optional=true (status) смягчает только «не подключён»-исходы: нет каналов или
  // нет учётки → { channel?, acc:null } вместо 404, чтобы status честно ответил connected:false.
  // Возвращает { channel, acc } или null (ответ уже отправлен).
  async function resolveMsChannel(req, res, { optional = false } = {}) {
    if (!db.enabled) {
      res.status(503).json({ error: 'База данных недоступна' });
      return null;
    }
    const channelId = parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
    const channel = await db.getChannelOrDefault(channelId, req.user).catch(() => null);
    if (!channel) {
      if (channelId) {
        res.status(403).json({ error: 'Нет доступа к этому каналу' });
        return null;
      }
      if (optional) return { channel: null, acc: null };
      res.status(404).json({ error: 'МойСклад не подключён к этому каналу' });
      return null;
    }
    const acc = await db.getMsAccount(channel.id).catch(() => null);
    if (!acc || !acc.access_token_enc) {
      if (optional) return { channel, acc: null };
      res.status(404).json({ error: 'МойСклад не подключён к этому каналу' });
      return null;
    }
    return { channel, acc };
  }

  // Пер-запросная идентичность МойСклада для live-вызовов (расшифрованный токен). Мок-фолбэка,
  // в отличие от IG, нет: без подключённого склада роут честно отвечает 404 и UI показывает
  // connect-CTA. Возвращает { channel, token } или null (ответ уже отправлен). Порядок проверок
  // сохранён прежним: БД → ключ шифрования → канал/учётка → decrypt.
  async function resolveMs(req, res) {
    if (!db.enabled) {
      res.status(503).json({ error: 'База данных недоступна' });
      return null;
    }
    if (!msCrypto.configured()) {
      res.status(503).json({ error: 'MS_TOKEN_KEY не задан' });
      return null;
    }
    const resolved = await resolveMsChannel(req, res);
    if (!resolved) return null;
    let token;
    try {
      token = msCrypto.decrypt(resolved.acc.access_token_enc);
    } catch (e) {
      // Ключ сменили / блоб побит: это серверная деградация, а не «не подключён» — честный 503.
      // Ни ciphertext, ни plaintext в лог не попадают (ошибка decrypt — статичная строка node).
      log('warn', 'ms_token_decrypt_failed', { channelId: resolved.channel.id, error: e.message });
      res.status(503).json({ error: 'Не удалось прочитать сохранённый токен МойСклада' });
      return null;
    }
    return { channel: resolved.channel, token };
  }

  // POST /api/ms/connect — подключить аккаунт МойСклада по API-токену. Валидация — живыми
  // identity-вызовами (/context/employee → accountId, /entity/organization → имя организации);
  // дедуп по accountId: повторный connect того же склада обновляет токен существующего канала.
  app.post('/api/ms/connect', requireAuth, async (req, res, next) => {
    try {
      if (!db.enabled) return res.status(503).json({ error: 'База данных недоступна' });
      if (!msCrypto.configured()) return res.status(503).json({ error: 'MS_TOKEN_KEY не задан' });
      const token = req.body && typeof req.body.token === 'string' ? req.body.token.trim() : '';
      if (!token) return res.status(400).json({ error: 'Укажи токен доступа МойСклада' });

      let accountId = '';
      let orgName = null;
      try {
        const ctx = await msFetch(token, '/context/employee');
        accountId = ctx && ctx.accountId ? String(ctx.accountId) : '';
        const orgs = await msFetch(token, '/entity/organization');
        const first = orgs && Array.isArray(orgs.rows) && orgs.rows[0];
        if (first && typeof first.name === 'string' && first.name.trim()) orgName = first.name.trim();
      } catch (e) {
        const status = Number(e && e.status) || 0;
        // Токена в e.message нет по построению msClient — логируем сообщение спокойно.
        log('warn', 'ms_connect_failed', { status, error: e && e.message });
        // Здесь 401/403 = ПРИСЛАННЫЙ токен не подошёл (ошибка ввода) — 400, а не
        // ms_token_revoked (тот про уже сохранённый и отозванный токен в data-роутах).
        if (status === 401 || status === 403) {
          return res.status(400).json({ error: 'Токен отклонён МойСкладом' });
        }
        if (status === 429) return sendMsError(res, e, { route: 'connect' });
        return res.status(502).json({ error: 'МойСклад недоступен' });
      }
      // 2xx без accountId — неожиданная форма ответа: честный upstream-fail, не «токен плохой».
      if (!accountId) return res.status(502).json({ error: 'МойСклад недоступен' });

      let channelId = await db.findMsChannelByAccount(req.user.uid, accountId);
      if (!channelId) {
        const created = await db.createMsChannel({ owner_uid: req.user.uid, name: orgName });
        if (!created) return res.status(503).json({ error: 'Не удалось создать канал' });
        channelId = created.id;
      }
      await db.saveMsAccount(channelId, {
        ms_account_id: accountId,
        org_name: orgName,
        access_token_enc: msCrypto.encrypt(token),
      });
      // Ротация токена/пере-connect существующего канала: старые ms:*-ответы могли быть собраны
      // умершим токеном — сбрасываем сразу (для свежесозданного канала purge — no-op).
      msCachePurge(channelId);
      res.json({ ok: true, channel_id: channelId, org_name: orgName });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/status — состояние подключения для Settings/connect-CTA. Без 404 при
  // отсутствии учётки (в отличие от data-роутов) и без расшифровки токена: connected — это
  // «строка ms_accounts существует», ничего секретного наружу.
  app.get('/api/ms/status', requireAuth, async (req, res, next) => {
    try {
      const resolved = await resolveMsChannel(req, res, { optional: true });
      if (!resolved) return;
      res.json({
        connected: !!resolved.acc,
        org_name: resolved.acc ? resolved.acc.org_name || null : null,
      });
    } catch (e) {
      next(e);
    }
  });

  // DELETE /api/ms/account — отключить МойСклад от канала. Сносится ТОЛЬКО учётка (токен);
  // канал и архив ms_daily живут дальше (история остаётся, повторный connect её продолжит).
  // Идемпотентно: повторный DELETE без учётки — тот же { ok:true }. Отключение — admin-действие
  // воркспейса (зеркало DELETE /api/ig/oauth).
  app.delete('/api/ms/account', requireAuth, async (req, res, next) => {
    try {
      const resolved = await resolveMsChannel(req, res, { optional: true });
      if (!resolved) return;
      if (!resolved.channel) {
        return res.status(404).json({ error: 'МойСклад не подключён к этому каналу' });
      }
      if (!hasWorkspaceRole(resolved.channel, req.user, 'admin')) {
        return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      }
      await db.deleteMsAccount(resolved.channel.id);
      // Кэш-ответы канала собраны отозванным подключением — выкидываем сразу, а не по TTL.
      msCachePurge(resolved.channel.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // POST /api/ms/backfill — запустить чанковый бэкфилл заказов покупателей в архив ms_orders
  // (движок jobs/msBackfillJob). Admin-действие воркспейса (образец DELETE /api/ms/account):
  // прогон тянет ВСЮ историю аккаунта у МС. Сам прогон — fire-and-forget: ответ сразу, durable
  // прогресс движок ведёт в ms_backfill_state, UI забирает его из GET /api/ms/backfill-status.
  // resolveMs (с расшифровкой) ДО старта: нерабочий токен/ключ даёт честный 503/401 сейчас,
  // а не тихий сбой в фоне. Повторный вызов при живом прогоне → 409 (движок single-flight'ит
  // и сам — на случай гонки двух запросов в одном процессе).
  app.post('/api/ms/backfill', requireAuth, async (req, res, next) => {
    try {
      const ms = await resolveMs(req, res);
      if (!ms) return;
      if (!hasWorkspaceRole(ms.channel, req.user, 'admin')) {
        return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      }
      if (await msBackfill.isBusy(ms.channel.id)) {
        return res.status(409).json({ error: 'Загрузка уже идёт' });
      }
      msBackfill.start(ms.channel.id).then(
        (out) => log('info', 'ms_backfill_finished', {
          channelId: ms.channel.id, status: out && out.status, fetched: out && out.fetched,
        }),
        // Исход-ошибка уже записана движком в state (UI её увидит) — здесь только журнал.
        (e) => log('warn', 'ms_backfill_failed', { channelId: ms.channel.id, error: e && e.message }),
      );
      res.json({ ok: true, status: 'running' });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/backfill-status — живой прогресс бэкфилла. СОЗНАТЕЛЬНО без memoryCache: UI
  // поллит счётчик во время прогона, TTL-кэш показывал бы замороженный прогресс; чтения дешёвые
  // (две PK/индекс-выборки). resolveMs без требования admin — смотреть прогресс может любой
  // участник воркспейса, форма 403/404/503 совпадает с data-роутами. fetched может отличаться
  // от total: оценка снята на старте, заказы создавались во время прогона — это ок.
  app.get('/api/ms/backfill-status', requireAuth, async (req, res, next) => {
    try {
      const ms = await resolveMs(req, res);
      if (!ms) return;
      const [state, ordersInDb] = await Promise.all([
        db.getMsBackfillState(ms.channel.id),
        db.countMsOrders(ms.channel.id),
      ]);
      res.json({
        status: state ? state.status : 'idle',
        fetched: state ? Number(state.fetched_count) || 0 : 0,
        total: state && state.total_estimate != null ? Number(state.total_estimate) : null,
        cursor_month: state && state.cursor_from ? String(state.cursor_from).slice(0, 7) : null,
        error: state && state.error ? state.error : null,
        orders_in_db: ordersInDb,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/summary?days=30 — выручка (продажи) и заказы дневными сериями за окно.
  // days=0 («Всё») — из архива ms_daily, без единого запроса к МС.
  app.get('/api/ms/summary', requireAuth, async (req, res, next) => {
    try {
      const days = daysOf(req);

      if (days === 0) {
        // Архивная ветка: канал резолвим и 404-им как data-роут (после отключения учётки «Всё»
        // ведёт себя как остальные периоды — connect-CTA), но токен НЕ трогаем: читаем только БД.
        const resolved = await resolveMsChannel(req, res);
        if (!resolved) return;
        const cacheKey = `ms:summary:${resolved.channel.id}:0`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json(cached);
        // ForActor — канон tenant-read (боундари-гвард запрещает *Internal в routes); повторный
        // ownership-чек поверх resolveMsChannel дёшев и не даёт разъехаться при рефакторинге.
        const rows = await db.getMsDailyAllForActor(resolved.channel.id, req.user);
        // Суммируем в копейках и конвертируем один раз на границе — как в живой ветке.
        let revenueKop = 0;
        let ordersKop = 0;
        let ordersCount = 0;
        const revSeries = [];
        const ordSeries = [];
        for (const r of rows) {
          const rev = Number(r.revenue_kopecks) || 0;
          const oSum = Number(r.orders_sum_kopecks) || 0;
          const oCount = Number(r.orders_count) || 0;
          revenueKop += rev;
          ordersKop += oSum;
          ordersCount += oCount;
          revSeries.push({ day: r.day, value: kopecksToRub(rev) });
          ordSeries.push({ day: r.day, sum: kopecksToRub(oSum), count: oCount });
        }
        const data = {
          revenue: { total: kopecksToRub(revenueKop), series: revSeries },
          orders: { totalSum: kopecksToRub(ordersKop), totalCount: ordersCount, series: ordSeries },
        };
        cacheSet(cacheKey, data);
        return res.json(data);
      }

      const ms = await resolveMs(req, res);
      if (!ms) return;
      const cacheKey = `ms:summary:${ms.channel.id}:${days}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      const { momentFrom, momentTo } = periodWindow(days);
      const q = `momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}&interval=day`;
      let sales;
      let orders;
      try {
        [sales, orders] = await Promise.all([
          msFetch(ms.token, `/report/sales/plotseries?${q}`),
          msFetch(ms.token, `/report/orders/plotseries?${q}`),
        ]);
      } catch (e) {
        return sendMsError(res, e, { route: 'summary', channelId: ms.channel.id });
      }

      // series-точка МС: { date: 'YYYY-MM-DD HH:MM:SS', sum: копейки, quantity }. Суммируем в
      // копейках и конвертируем один раз — не копим float-хвосты по точкам.
      const salesSeries = sales && Array.isArray(sales.series) ? sales.series : [];
      const orderSeries = orders && Array.isArray(orders.series) ? orders.series : [];
      let revenueKop = 0;
      const revSeries = salesSeries.map((p) => {
        const sum = Number(p && p.sum) || 0;
        revenueKop += sum;
        return { day: String((p && p.date) || '').slice(0, 10), value: kopecksToRub(sum) };
      });
      let ordersKop = 0;
      let ordersCount = 0;
      const ordSeries = orderSeries.map((p) => {
        const sum = Number(p && p.sum) || 0;
        const count = Number(p && p.quantity) || 0;
        ordersKop += sum;
        ordersCount += count;
        return { day: String((p && p.date) || '').slice(0, 10), sum: kopecksToRub(sum), count };
      });
      const data = {
        revenue: { total: kopecksToRub(revenueKop), series: revSeries },
        orders: { totalSum: kopecksToRub(ordersKop), totalCount: ordersCount, series: ordSeries },
      };
      cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/top-products?days=30&limit=10 — топ товаров по прибыли за окно.
  // days=0 здесь НЕ поддержан: у МС profit/byproduct — только оконный отчёт, а архива
  // по-товарно мы не копим (слайс 2а — только дневные суммы), поэтому 0 падает в дефолт 30.
  app.get('/api/ms/top-products', requireAuth, async (req, res, next) => {
    try {
      const ms = await resolveMs(req, res);
      if (!ms) return;
      const daysRaw = daysOf(req);
      const days = daysRaw === 0 ? 30 : daysRaw;
      const limitRaw = parseInt(req.query.limit, 10);
      // Кэп 1..50 ДО кэш-ключа — та же дисциплина ограниченной кардинальности, что у days.
      const limit = Math.min(MS_TOP_LIMIT_MAX, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : MS_TOP_LIMIT_DEFAULT));
      const cacheKey = `ms:top:${ms.channel.id}:${days}:${limit}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      const { momentFrom, momentTo } = periodWindow(days);
      let report;
      try {
        report = await msFetch(
          ms.token,
          `/report/profit/byproduct?momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}&limit=${limit}`,
        );
      } catch (e) {
        return sendMsError(res, e, { route: 'top-products', channelId: ms.channel.id });
      }

      const rows = (report && Array.isArray(report.rows) ? report.rows : []).map((r) => ({
        name: r && r.assortment && typeof r.assortment.name === 'string' ? r.assortment.name : null,
        quantity: Number(r && r.sellQuantity) || 0,
        revenue: kopecksToRub(Number(r && r.sellSum) || 0),
        profit: kopecksToRub(Number(r && r.profit) || 0),
      }));
      // meta.size — полный размер выборки у МС (страница может быть короче лимита).
      const metaSize = Number(report && report.meta && report.meta.size);
      const data = { rows, total: Number.isFinite(metaSize) ? metaSize : rows.length };
      cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });
}

module.exports = { registerMsRoutes };
