'use strict';

const { kopecksToRub } = require('../lib/msClient');

/**
 * Роуты МойСклада (/api/ms/{connect,summary,top-products}) — серверная половина источника
 * «склад», зеркально Instagram-вертикали: connect валидирует токен живыми identity-вызовами
 * и сохраняет его ТОЛЬКО шифрованным (lib/ms_crypto), data-роуты резолвят канал тем же
 * механизмом, что resolveIg (?channel= / заголовок x-channel-id, дефолт через
 * db.getChannelOrDefault — тот же ownership/disabled-предикат), и кэшируются как IG-роуты
 * (дефолтный TTL memoryCache). Все суммы наружу — в РУБЛЯХ (kopecksToRub), внутри МС — копейки.
 * Токен нигде не логируется и не попадает в ответы/сообщения ошибок (msClient держит его
 * только в заголовке запроса).
 */
function registerMsRoutes({ app, requireAuth, db, msCrypto, msFetch, cacheGet, cacheSet, log }) {
  // Узкий enum периодов ДО кэш-ключа (как nearestOf у IG): произвольный days плодил бы
  // per-value кэш-записи, каждая ценой пары upstream-запросов. Не-enum → дефолт 30.
  const MS_DAYS_ALLOWED = [7, 30, 90];
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
  // через пару секунд» точнее, чем маскировать под 502. Всё остальное (сеть/5xx/протухший
  // токен) → 502 «МойСклад недоступен». В лог — только path-контекст/статус, никогда токен.
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
    return res.status(502).json({ error: 'МойСклад недоступен' });
  }

  // Пер-запросная идентичность МойСклада для канала запроса. Канал приходит тем же путём,
  // что у resolveIg: ?channel= / заголовок x-channel-id, при их отсутствии — дефолтный канал
  // пользователя (db.getChannelOrDefault — тот же ownership/disabled-предикат, что getChannel).
  // Мок-фолбэка, в отличие от IG, нет: без подключённого склада роут честно отвечает 404 и
  // UI показывает connect-CTA. Возвращает { channel, token } или null (ответ уже отправлен).
  async function resolveMs(req, res) {
    if (!db.enabled) {
      res.status(503).json({ error: 'База данных недоступна' });
      return null;
    }
    if (!msCrypto.configured()) {
      res.status(503).json({ error: 'MS_TOKEN_KEY не задан' });
      return null;
    }
    const channelId = parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
    const channel = await db.getChannelOrDefault(channelId, req.user).catch(() => null);
    if (!channel) {
      // Явный id без доступа → 403 (не раскрываем существование канала); дефолт без каналов → 404.
      if (channelId) res.status(403).json({ error: 'Нет доступа к этому каналу' });
      else res.status(404).json({ error: 'МойСклад не подключён к этому каналу' });
      return null;
    }
    const acc = await db.getMsAccount(channel.id).catch(() => null);
    if (!acc || !acc.access_token_enc) {
      res.status(404).json({ error: 'МойСклад не подключён к этому каналу' });
      return null;
    }
    let token;
    try {
      token = msCrypto.decrypt(acc.access_token_enc);
    } catch (e) {
      // Ключ сменили / блоб побит: это серверная деградация, а не «не подключён» — честный 503.
      // Ни ciphertext, ни plaintext в лог не попадают (ошибка decrypt — статичная строка node).
      log('warn', 'ms_token_decrypt_failed', { channelId: channel.id, error: e.message });
      res.status(503).json({ error: 'Не удалось прочитать сохранённый токен МойСклада' });
      return null;
    }
    return { channel, token };
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
      res.json({ ok: true, channel_id: channelId, org_name: orgName });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/summary?days=30 — выручка (продажи) и заказы дневными сериями за окно.
  app.get('/api/ms/summary', requireAuth, async (req, res, next) => {
    try {
      const ms = await resolveMs(req, res);
      if (!ms) return;
      const days = daysOf(req);
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
  app.get('/api/ms/top-products', requireAuth, async (req, res, next) => {
    try {
      const ms = await resolveMs(req, res);
      if (!ms) return;
      const days = daysOf(req);
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
