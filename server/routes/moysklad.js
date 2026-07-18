'use strict';

const { kopecksToRub } = require('../lib/msClient');
const { hasWorkspaceRole } = require('../middleware/tenant');

/**
 * Роуты МойСклада (/api/ms/{connect,summary,top-products,top-customers,status,account,backfill,
 * backfill-status,funnel,customers,cohorts,returns,sales-by-channel,geography}) — серверная половина
 * источника «склад», зеркально Instagram-вертикали: connect валидирует токен живыми
 * identity-вызовами и сохраняет его ТОЛЬКО шифрованным (lib/ms_crypto), data-роуты резолвят
 * канал тем же механизмом, что resolveIg (?channel= / заголовок x-channel-id, дефолт через
 * db.getChannelOrDefault — тот же ownership/disabled-предикат), и кэшируются как IG-роуты
 * (дефолтный TTL memoryCache). Все суммы наружу — в РУБЛЯХ (kopecksToRub), внутри МС/БД —
 * копейки. Токен нигде не логируется и не попадает в ответы/сообщения ошибок (msClient держит
 * его только в заголовке запроса). days=0 («Всё») в summary обслуживается ИЗ АРХИВА ms_daily
 * (его копит jobs/msCollectionJob) — живых вызовов МС не делает и токена не требует; в
 * top-products «Всё» — живой отчёт полного диапазона от старейшего заказа архива (кэш 1 час).
 * Слайс 3 (funnel/customers/cohorts) читает архив ms_orders (движок jobs/msBackfillJob) —
 * дешёвые DB-агрегаты без кэша; живой у них только словарь статусов (funnel) и /returns
 * (page-loop). top-customers — тот же DB-агрегат + живой словарь имён контрагентов одним
 * вызовом. Слайс 6 (sales-by-channel/geography, миграция 031) — тоже DB-агрегаты архива:
 * sales-by-channel добирает имена/типы каналов живым словарём saleschannel (кэш 1 час, зеркало
 * loadStatesDict), geography — чистый DB с нормализацией города в SQL, без словаря и кэша.
 * connect/disconnect пишут audit-события ms_connect/ms_disconnect (зеркало ig-oauth) —
 * только identity-поля учётки, токенов в metadata нет.
 * sleepFn — инъекция паузы page-loop'а для детерминированных тестов (как у движка бэкфилла).
 */
function registerMsRoutes({ app, requireAuth, db, audit, msCrypto, msFetch, msBackfill, cacheGet, cacheSet, cache, log, sleepFn }) {
  // Узкий enum периодов ДО кэш-ключа (как nearestOf у IG): произвольный days плодил бы
  // per-value кэш-записи, каждая ценой пары upstream-запросов. 0 = «Всё» (summary — архив
  // ms_daily без upstream; top-products — живой отчёт полного диапазона). Не-enum → дефолт 30.
  const MS_DAYS_ALLOWED = [0, 7, 30, 90];
  const daysOf = (req) => {
    const n = parseInt(req.query.days, 10);
    return MS_DAYS_ALLOWED.includes(n) ? n : 30;
  };
  const MS_TOP_LIMIT_DEFAULT = 10;
  const MS_TOP_LIMIT_MAX = 50;
  const MS_TOP_SORTS = new Set(['revenue', 'profit', 'margin']);
  const topSortOf = (req) => (MS_TOP_SORTS.has(req.query.sort) ? req.query.sort : 'revenue');
  // Страничная добивка отчёта прибыльности для топа: МС не сортирует отчёт по выручке, поэтому
  // окно добирается целиком (страницы по 1000, тот же потолок API, что у /returns) и сортируется
  // у нас. Cap 3 страницы = 3000 позиций ассортимента за окно; больше — честный truncated.
  const MS_TOP_PAGE_LIMIT = 1000;
  const MS_TOP_PAGE_CAP = 3;
  const MS_TOP_PAGE_PAUSE_MS = 150;
  // «Всё» у топа товаров — живой отчёт ПОЛНОГО диапазона (на складе владельца ~1116 позиций,
  // страницы по ~3с) → отдельный кэш 1 час: пересобирать чаще дорого, а история меняется
  // медленно. Живые окна (7/30/90) остаются на коротком дефолтном TTL.
  const MS_TOP_ALL_CACHE_TTL_MS = 60 * 60 * 1000;
  // Живой page-loop /api/ms/returns: страницы по 1000 (лимит МС без expand) с паузой, как у
  // движка бэкфилла; cap 5 страниц — потолок одного запроса (5000 возвратов за окно; больше —
  // честный truncated, не бесконечный проход по чужому лимиту 45/3с).
  const MS_RETURNS_PAGE_LIMIT = 1000;
  const MS_RETURNS_PAGE_CAP = 5;
  const MS_RETURNS_PAGE_PAUSE_MS = 150;
  // Живые вызовы дорогие → кэш: словари статусов и каналов продаж меняются редко (1 час,
  // инвалидация TTL'ом), возвраты — обычный data-TTL 10 минут.
  const MS_STATES_CACHE_TTL_MS = 60 * 60 * 1000;
  const MS_CHANNELS_CACHE_TTL_MS = 60 * 60 * 1000;
  const MS_RETURNS_CACHE_TTL_MS = 10 * 60 * 1000;
  const sleep = sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // 'YYYY-MM-DD' по местным часам процесса (Railway = UTC) — как остальные дневные окна бэка.
  const fmtDay = (d) => {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };
  // Окно периода: «сегодня-(days-1) 00:00:00» … «сегодня 23:59:59» — границы moment
  // у отчётов МС включительные, day-серия plotseries отдаёт ровно days точек.
  function periodWindow(days) {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    return { momentFrom: `${fmtDay(from)} 00:00:00`, momentTo: `${fmtDay(now)} 23:59:59` };
  }
  // Нижняя граница того же календарного окна для DB-агрегатов ms_orders: 'YYYY-MM-DD' или
  // null («Всё» = вся история архива). Та же система координат, что periodWindow/движок.
  const sinceDayOf = (days) => {
    if (days === 0) return null;
    const now = new Date();
    return fmtDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)));
  };
  const isDayKey = (v) => {
    if (typeof v !== 'string') return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  };

  // Единый разбор периода ВСЕХ data-роутов: пресет days ЛИБО точный произвольный диапазон
  // (?from&to=YYYY-MM-DD, инклюзивный с обоих концов — окно топбара). Фронт всегда шлёт days
  // (пресет-фолбэк) рядом с from/to. Возвращает:
  //   invalid=true — from/to присланы, но кривые/перевёрнуты: роут честно отвечает 400, а не
  //                  молча расширяет окно.
  //   sinceDay/untilDay — инклюзивные дневные границы для DB-агрегатов (repo применяет
  //                       moment>=since и moment<until+1); пресеты и «Всё» заканчиваются сегодня.
  //   momentFrom/momentTo — инклюзивные 'YYYY-MM-DD HH:MM:SS' границы для ЖИВЫХ отчётов МС;
  //                         оба null у пресета «Всё» (days=0 — без окна).
  //   range — true для произвольного диапазона (отличает его от days=0 в ветвлениях роутов).
  //   periodKey — стабильный кэш-токен ('r:from:to' | 'd:days').
  function parseMsPeriod(req) {
    const days = daysOf(req);
    const rawFrom = req.query.from;
    const rawTo = req.query.to;
    if (rawFrom != null || rawTo != null) {
      if (!isDayKey(rawFrom) || !isDayKey(rawTo) || rawFrom > rawTo) {
        return { invalid: true };
      }
      return {
        invalid: false, range: true, days,
        sinceDay: rawFrom, untilDay: rawTo,
        momentFrom: `${rawFrom} 00:00:00`, momentTo: `${rawTo} 23:59:59`,
        periodKey: `r:${rawFrom}:${rawTo}`,
      };
    }
    const win = days === 0 ? null : periodWindow(days);
    const today = fmtDay(new Date());
    return {
      invalid: false, range: false, days,
      // Архив также ограничиваем сегодняшним днём: будущие датированные заказы не должны
      // попадать в 7/30/90/«Всё», пока top bar показывает окно, заканчивающееся сегодня.
      sinceDay: sinceDayOf(days), untilDay: today,
      momentFrom: win ? win.momentFrom : null, momentTo: win ? win.momentTo : null,
      periodKey: `d:${days}`,
    };
  }
  // Ошибочный диапазон — честный 400 (не «сервис недоступен», не тихое расширение окна).
  const badRange = (res) =>
    res.status(400).json({ error: 'Некорректный диапазон дат (ожидается from<=to в формате YYYY-MM-DD)' });

  // Мультивыбор каналов в channel-series: список id жёстко ограничен, чтобы фильтр `= ANY(...)`
  // и breakdown не разрастались. Разбивку на отдельные серии дополнительно кэпуем читаемым лимитом.
  const MS_CHANNEL_SERIES_MAX = 20;
  const MS_CHANNEL_SERIES_GROUP_MAX = 6;
  const isMsChannelId = (v) =>
    typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);

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
      // Аудит подключения (зеркало ig_oauth_connected): только identity-поля — id учётки МС и
      // имя организации. Токена в metadata нет и быть не может: audit-строки живут год.
      await audit(req, 'ms_connect', { channelId, msAccountId: accountId, orgName });
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
      // Аудит отключения (зеркало ig_oauth_disconnected): ms_account_id — безопасный
      // identity-факт («кто отключил какой склад»), у идемпотентного повтора его нет → null.
      await audit(req, 'ms_disconnect', {
        channelId: resolved.channel.id,
        msAccountId: (resolved.acc && resolved.acc.ms_account_id) || null,
      });
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
      const period = parseMsPeriod(req);
      if (period.invalid) return badRange(res);

      if (period.days === 0 && !period.range) {
        // Архивная ветка: канал резолвим и 404-им как data-роут (после отключения учётки «Всё»
        // ведёт себя как остальные периоды — connect-CTA), но токен НЕ трогаем: читаем только БД.
        // Произвольный диапазон сюда НЕ попадает (range=false) — он всегда идёт живым plotseries.
        const resolved = await resolveMsChannel(req, res);
        if (!resolved) return;
        const cacheKey = `ms:summary:${resolved.channel.id}:${period.periodKey}`;
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
      const cacheKey = `ms:summary:${ms.channel.id}:${period.periodKey}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      const { momentFrom, momentTo } = period;
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

  // GET /api/ms/top-products?days=30&limit=10&sort=revenue|profit|margin — рейтинг товаров.
  // МС отдаёт отчёт НЕ по выручке (фактически — алфавит ассортимента), а сортировка в
  // параметрах отчёта не документирована → добираем окно постранично (limit/offset, cap и
  // пауза — как у /returns) и сортируем у себя; наружу уходят первые limit строк.
  // days=0 («Всё»): по-товарного архива нет (слайс 2а копит только дневные суммы), поэтому
  // «Всё» — тот же живой отчёт, но с окном от первого дня месяца СТАРЕЙШЕГО заказа канала в
  // архиве ms_orders до сейчас (полный диапазон проверен живым токеном: profit/byproduct
  // отвечает ~3.6с на страницу при ~1116 позициях — страницы/cap те же). Пустой архив
  // (бэкфилл ещё не запускали) → консервативный якорь '2020-01-01': он раньше любого реального
  // склада продукта, а лишние пустые месяцы отчёту МС не вредят — строк за них просто нет.
  app.get('/api/ms/top-products', requireAuth, async (req, res, next) => {
    try {
      const period = parseMsPeriod(req);
      if (period.invalid) return badRange(res);
      const ms = await resolveMs(req, res);
      if (!ms) return;
      const limitRaw = parseInt(req.query.limit, 10);
      // Кэп 1..50 ДО кэш-ключа — та же дисциплина ограниченной кардинальности, что у days.
      const limit = Math.min(MS_TOP_LIMIT_MAX, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : MS_TOP_LIMIT_DEFAULT));
      const sort = topSortOf(req);
      // Полный нормализованный отчёт кэшируется ОДИН раз на окно: переключение сортировки и limit
      // не должно повторять дорогой page-loop МойСклада. Слот channelId остаётся третьим, поэтому
      // connect/disconnect точечно инвалидирует raw-кэш через общий msCachePurge.
      const rawCacheKey = `ms:topraw:${ms.channel.id}:${period.periodKey}`;
      let raw = cacheGet(rawCacheKey);

      if (!raw) {
        let momentFrom;
        let momentTo;
        if (period.momentFrom) {
          // Пресет 7/30/90 или произвольный диапазон — окно уже посчитано разбором периода.
          ({ momentFrom, momentTo } = period);
        } else {
          // days=0 «Всё»: ForActor — канон tenant-read. oldestDay 'YYYY-MM-DD' → якорь окна с
          // первого дня того же месяца (полные месяцы читаются человеком как «вся история»).
          const oldestDay = await db.getMsOldestOrderDayForActor(ms.channel.id, req.user);
          momentFrom = `${oldestDay ? `${oldestDay.slice(0, 7)}-01` : '2020-01-01'} 00:00:00`;
          momentTo = `${fmtDay(new Date())} 23:59:59`;
        }
        const all = [];
        let metaSize = null;
        let truncated = false;
        try {
          let offset = 0;
          for (let page = 0; ; page++) {
            const report = await msFetch(
              ms.token,
              `/report/profit/byproduct?momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}` +
                `&limit=${MS_TOP_PAGE_LIMIT}&offset=${offset}`,
            );
            const pageRows = report && Array.isArray(report.rows) ? report.rows : [];
            if (page === 0) {
              // meta.size — полный размер выборки у МС (страница может быть короче лимита).
              const size = Number(report && report.meta && report.meta.size);
              metaSize = Number.isFinite(size) ? size : null;
            }
            for (const r of pageRows) {
              all.push({
                name: r && r.assortment && typeof r.assortment.name === 'string' ? r.assortment.name : null,
                quantity: Number(r && r.sellQuantity) || 0,
                // Копейки как есть до самого выхода — сортировка по целым, рубли на границе.
                revenueKopecks: Math.round(Number(r && r.sellSum) || 0),
                profitKopecks: Math.round(Number(r && r.profit) || 0),
              });
            }
            if (pageRows.length < MS_TOP_PAGE_LIMIT) break;                     // хвост добран
            if (page + 1 >= MS_TOP_PAGE_CAP) { truncated = true; break; }       // упёрлись в cap
            offset += MS_TOP_PAGE_LIMIT;
            await sleep(MS_TOP_PAGE_PAUSE_MS);
          }
        } catch (e) {
          return sendMsError(res, e, { route: 'top-products', channelId: ms.channel.id });
        }
        raw = { rows: all, total: metaSize != null ? metaSize : all.length, truncated };
        if (period.days === 0 && !period.range) cacheSet(rawCacheKey, raw, MS_TOP_ALL_CACHE_TTL_MS);
        else cacheSet(rawCacheKey, raw);
      }

      const marginOf = (r) => (r.revenueKopecks > 0 ? (r.profitKopecks / r.revenueKopecks) * 100 : null);
      // Сортируем КОПИЮ полного отчёта до limit. Для неопределённой маржи (выручка <= 0) место
      // всегда в хвосте; затем устойчивые финансовые tie-break'и и имя.
      const ranked = [...raw.rows].sort((a, b) => {
        if (sort === 'profit') {
          return b.profitKopecks - a.profitKopecks || b.revenueKopecks - a.revenueKopecks ||
            b.quantity - a.quantity || String(a.name || '').localeCompare(String(b.name || ''), 'ru');
        }
        if (sort === 'margin') {
          const am = marginOf(a);
          const bm = marginOf(b);
          if (am == null && bm != null) return 1;
          if (am != null && bm == null) return -1;
          return (bm ?? 0) - (am ?? 0) || b.profitKopecks - a.profitKopecks ||
            b.revenueKopecks - a.revenueKopecks || String(a.name || '').localeCompare(String(b.name || ''), 'ru');
        }
        return b.revenueKopecks - a.revenueKopecks || b.quantity - a.quantity ||
          b.profitKopecks - a.profitKopecks || String(a.name || '').localeCompare(String(b.name || ''), 'ru');
      });
      const rows = ranked.slice(0, limit).map((r) => ({
        name: r.name,
        quantity: r.quantity,
        revenue: kopecksToRub(r.revenueKopecks),
        profit: kopecksToRub(r.profitKopecks),
        margin: r.revenueKopecks > 0 ? Math.round(marginOf(r) * 100) / 100 : null,
      }));
      res.json({ rows, total: raw.total, truncated: raw.truncated });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/top-customers?days= — топ клиентов по сумме заказов за окно (архив ms_orders,
  // days=0 = вся история). Сам агрегат — дешёвое DB-чтение (ForActor — канон tenant-read);
  // живой только словарь имён: контрагентов у склада тысячи (у владельца ~10k), полный
  // справочник не нужен — имена ≤10 строк топа добираются ОДНИМ вызовом /entity/counterparty
  // с OR-фильтром `filter=id=<uuid>;id=<uuid>` («;» между условиями одного поля у МС — OR;
  // проверено живым токеном), фильтр целиком URL-encoded — как у движка бэкфилла.
  // Кэш — ВЕСЬ ответ роута на дефолтные 10 минут по days: проще отдельного часового кэша имён
  // (`ms:cpnames:<ids>`) — ключей ровно enum days (а не комбинации id), правила инвалидации
  // одни на роут (msCachePurge снимает и его), а кэш-хит не делает вообще ничего, даже
  // DB-агрегата. Сбой словаря НЕ роняет роут — rows с name:null (зеркало деградации
  // loadStatesDict), и такой деградированный ответ сознательно НЕ кэшируем: следующий запрос
  // попробует имена снова, а не залипнет безымянным на весь TTL. Исключение — 401/403 от МС:
  // токен отозван, честный ms_token_revoked-путь (reconnect-CTA, как у остальных data-роутов);
  // молчаливый name:null здесь прятал бы умершее подключение.
  app.get('/api/ms/top-customers', requireAuth, async (req, res, next) => {
    try {
      const period = parseMsPeriod(req);
      if (period.invalid) return badRange(res);
      const ms = await resolveMs(req, res);
      if (!ms) return;
      const cacheKey = `ms:topcust:${ms.channel.id}:${period.periodKey}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      const top = await db.getMsTopCustomersForActor(ms.channel.id, req.user, {
        sinceDay: period.sinceDay, untilDay: period.untilDay,
      });
      // null = словарь недоступен (деградация), Map = удачный резолв; пустой Map — тоже ответ
      // (все контрагенты топа удалены из МС — их имена честно null, но кэшировать можно).
      let names = null;
      if (top.length) {
        const filter = top.map((r) => `id=${r.agent_id}`).join(';');
        try {
          const cps = await msFetch(
            ms.token,
            `/entity/counterparty?filter=${encodeURIComponent(filter)}&limit=${top.length}`,
          );
          names = new Map();
          for (const c of cps && Array.isArray(cps.rows) ? cps.rows : []) {
            if (c && c.id != null) names.set(String(c.id), typeof c.name === 'string' ? c.name : null);
          }
        } catch (e) {
          const status = Number(e && e.status) || 0;
          if (status === 401 || status === 403) {
            return sendMsError(res, e, { route: 'top-customers', channelId: ms.channel.id });
          }
          log('warn', 'ms_counterparty_names_failed', {
            channelId: ms.channel.id, status, error: e && e.message,
          });
        }
      }
      const data = {
        window_days: period.days,
        rows: top.map((r) => ({
          agent_id: r.agent_id,
          // Контрагент удалён/не найден в словаре → name null — фронт покажет заглушку.
          name: names ? (names.get(String(r.agent_id)) ?? null) : null,
          orders: r.orders,
          sum: kopecksToRub(r.sum_kopecks),
        })),
      };
      if (names !== null || !top.length) cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // Словарь статусов заказов канала: id → { name, color:'#rrggbb' } из
  // GET /entity/customerorder/metadata (state.meta.href заказов оканчивается
  // metadata/states/<uuid> — тем же uuid ключуем словарь). color у МС — int RGB → hex-строка.
  // Кэш 1 час (`ms:states:<channelId>` — msCachePurge при disconnect его тоже снимет, слот
  // канала третий); словарь меняется редко, TTL достаточно. Сбой словаря (МС лёг/токен отозван)
  // деградирует МЯГКО: null, funnel отвечает голыми id — DB-агрегат не заложник живого МС.
  // Неуспех сознательно НЕ кэшируем — следующий запрос попробует снова.
  async function loadStatesDict(ms) {
    const cacheKey = `ms:states:${ms.channel.id}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    let meta;
    try {
      meta = await msFetch(ms.token, '/entity/customerorder/metadata');
    } catch (e) {
      log('warn', 'ms_states_dict_failed', {
        channelId: ms.channel.id, status: Number(e && e.status) || 0, error: e && e.message,
      });
      return null;
    }
    const dict = {};
    const states = meta && Array.isArray(meta.states) ? meta.states : [];
    for (const s of states) {
      if (!s || s.id == null) continue;
      const colorNum = Number(s.color);
      dict[String(s.id)] = {
        name: typeof s.name === 'string' ? s.name : null,
        // >>>0 и slice(-6) — страховки от отрицательного/переполненного int; канон МС — 24-бит RGB.
        color: Number.isFinite(colorNum)
          ? `#${(colorNum >>> 0).toString(16).padStart(6, '0').slice(-6)}`
          : null,
      };
    }
    cacheSet(cacheKey, dict, MS_STATES_CACHE_TTL_MS);
    return dict;
  }

  // Словарь каналов продаж канала: id → { name, type } из GET /entity/saleschannel?limit=100
  // (у склада каналов десятки — одна страница с запасом; saleschannel.meta.href заказов
  // оканчивается …/entity/saleschannel/<uuid> — тем же uuid ключуем). Кэш 1 час
  // (`ms:channels:<channelId>` — msCachePurge при disconnect его тоже снимет, слот канала третий);
  // словарь меняется редко. Мягкая деградация как у loadStatesDict: сеть/5xx → null
  // (sales-by-channel отдаёт голые id), неуспех НЕ кэшируем. ИСКЛЮЧЕНИЕ — 401/403: токен отозван,
  // re-throw наружу → ms_token_revoked-путь роута (молчаливый name:null прятал бы умершее
  // подключение, как в top-customers).
  async function loadChannelsDict(ms) {
    const cacheKey = `ms:channels:${ms.channel.id}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    let data;
    try {
      data = await msFetch(ms.token, '/entity/saleschannel?limit=100');
    } catch (e) {
      const status = Number(e && e.status) || 0;
      if (status === 401 || status === 403) throw e;   // отозванный токен — наверх, не глотаем
      log('warn', 'ms_channels_dict_failed', {
        channelId: ms.channel.id, status, error: e && e.message,
      });
      return null;
    }
    const dict = {};
    const rows = data && Array.isArray(data.rows) ? data.rows : [];
    for (const c of rows) {
      if (!c || c.id == null) continue;
      dict[String(c.id)] = {
        name: typeof c.name === 'string' ? c.name : null,
        type: typeof c.type === 'string' ? c.type : null,
      };
    }
    cacheSet(cacheKey, dict, MS_CHANNELS_CACHE_TTL_MS);
    return dict;
  }

  // GET /api/ms/sales-by-channel?days= — продажи по каналам сбыта за окно (архив ms_orders,
  // days=0 = вся история). Сам агрегат — дешёвое DB-чтение БЕЗ кэша ответа; живой только словарь
  // имён/типов каналов (см. loadChannelsDict, кэш 1 час). Строка sales_channel_id=NULL (заказы
  // без канала / строки до миграции 031) в rows не кладётся — уходит счётчиком no_channel_orders
  // (как no_state_orders у воронки). resolveMs (не resolveMsChannel): словарю нужен токен, а «не
  // подключён» здесь отвечает 404 как остальные data-роуты.
  app.get('/api/ms/sales-by-channel', requireAuth, async (req, res, next) => {
    try {
      const period = parseMsPeriod(req);
      if (period.invalid) return badRange(res);
      const ms = await resolveMs(req, res);
      if (!ms) return;
      // ForActor — канон tenant-read (как funnel): повторный ownership-чек дёшев.
      const rows = await db.getMsSalesByChannelForActor(ms.channel.id, req.user, {
        sinceDay: period.sinceDay, untilDay: period.untilDay,
      });
      let dict;
      try {
        dict = await loadChannelsDict(ms);
      } catch (e) {
        // 401/403 из словаря = отозванный токен: честный reconnect-CTA (loadChannelsDict глотает
        // только сеть/5xx → null; ms_token_revoked он пробрасывает наверх).
        return sendMsError(res, e, { route: 'sales-by-channel', channelId: ms.channel.id });
      }
      let totalOrders = 0;
      let noChannelOrders = 0;
      const out = [];
      for (const r of rows) {
        totalOrders += r.orders;
        if (r.sales_channel_id == null) {
          noChannelOrders += r.orders;
          continue;
        }
        const ch = dict ? dict[r.sales_channel_id] : null;
        out.push({
          sales_channel_id: r.sales_channel_id,
          // Канал удалён/словарь недоступен → name/type null (фронт покажет заглушку).
          name: ch ? ch.name : null,
          type: ch ? ch.type : null,
          orders: r.orders,
          sum: kopecksToRub(r.sum_kopecks),
        });
      }
      res.json({ window_days: period.days, total_orders: totalOrders, no_channel_orders: noChannelOrders, rows: out });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/geography?days= — топ городов доставки за окно (архив ms_orders, days=0 = вся
  // история). Чистый DB-агрегат БЕЗ словаря и БЕЗ кэша: город нормализован в SQL («г Москва» и
  // «Москва» — один город), заказы без города/самовывоз считаются отдельно (no_city_orders).
  // Суммы наружу — в рублях. resolveMs (как customers/cohorts): единая форма 404/401/503, хотя
  // токен здесь не нужен.
  app.get('/api/ms/geography', requireAuth, async (req, res, next) => {
    try {
      const period = parseMsPeriod(req);
      if (period.invalid) return badRange(res);
      const ms = await resolveMs(req, res);
      if (!ms) return;
      const geo = await db.getMsGeographyForActor(ms.channel.id, req.user, {
        sinceDay: period.sinceDay, untilDay: period.untilDay,
      });
      res.json({
        window_days: period.days,
        total_orders: geo.total_orders,
        no_city_orders: geo.no_city_orders,
        rows: geo.rows.map((r) => ({ city: r.city, orders: r.orders, sum: kopecksToRub(r.sum_kopecks) })),
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/channel-series?days=&channels=<id,id,…>&breakdown=1 — дневная серия выручки/заказов
  // по оси каналов продаж (слайс 6в «настроить график по источнику», расширено до мультивыбора).
  //   channels отсутствует/'all' → все каналы, АГРЕГАТ (Steep: фильтр = агрегация выбранных).
  //   channels=<список id> → агрегат ТОЛЬКО по выбранным (bounded ≤20, только UUID-подобные id,
  //                          дубликаты схлопнуты, мусор отброшен — в SQL уходит text[]-бинд).
  //   breakdown=1 (только при выбранных каналах) → плюс `groups` — по серии на канал (bounded
  //                          читаемым лимитом; group_total/group_limit говорят об усечении честно).
  // Обратная совместимость: legacy `channel=<id>` понимается как channels с одним id. Чистый
  // DB-агрегат из архива ms_orders БЕЗ словаря/кэша; серия — только дни с заказами (фронт дозаполняет
  // нули). Суммы наружу — в рублях. Произвольный диапазон топбара honored через parseMsPeriod.
  app.get('/api/ms/channel-series', requireAuth, async (req, res, next) => {
    try {
      const period = parseMsPeriod(req);
      if (period.invalid) return badRange(res);
      const ms = await resolveMs(req, res);
      if (!ms) return;

      const raw = typeof req.query.channels === 'string' ? req.query.channels
        : typeof req.query.channel === 'string' ? req.query.channel   // legacy single
          : '';
      // 'all'/пусто → нет выбора (все каналы). Явный список принимается только целиком:
      // тихо отбросить битый/21-й id означало бы показать данные НЕ по выбранному фильтру.
      const parsed = raw === 'all' || raw === '' ? [] : raw.split(',').map((s) => s.trim());
      if (parsed.some((id) => !isMsChannelId(id))) {
        return res.status(400).json({ error: 'Некорректный идентификатор канала продаж' });
      }
      const selected = [...new Set(parsed)];
      if (selected.length > MS_CHANNEL_SERIES_MAX) {
        return res.status(400).json({ error: `Можно выбрать не более ${MS_CHANNEL_SERIES_MAX} каналов` });
      }
      const salesChannelIds = selected.length ? selected : null;
      const breakdown = selected.length > 0 && (req.query.breakdown === '1' || req.query.breakdown === 'true');

      const agg = await db.getMsChannelSeriesForActor(ms.channel.id, req.user, {
        sinceDay: period.sinceDay, untilDay: period.untilDay, salesChannelIds,
      });

      let groups = null;
      let groupLimit;
      let groupTotal;
      if (breakdown) {
        // Разбивку на отдельные серии кэпуем читаемым лимитом; остаток честно отражают
        // group_total (сколько выбрано) vs group_limit (сколько серий отдали).
        const groupIds = selected.slice(0, MS_CHANNEL_SERIES_GROUP_MAX);
        const flat = await db.getMsChannelSeriesGroupedForActor(ms.channel.id, req.user, {
          sinceDay: period.sinceDay, untilDay: period.untilDay, salesChannelIds: groupIds,
        });
        const byChannel = new Map();
        for (const r of flat) {
          if (!byChannel.has(r.sales_channel_id)) byChannel.set(r.sales_channel_id, []);
          byChannel.get(r.sales_channel_id).push({ day: r.day, orders: r.orders, sum: kopecksToRub(r.sum_kopecks) });
        }
        // Порядок серий = порядок выбранных id (стабилен, детерминирован для тестов).
        groups = groupIds.map((id) => ({ sales_channel_id: id, series: byChannel.get(id) || [] }));
        groupTotal = selected.length;
        groupLimit = groupIds.length;
      }

      res.json({
        window_days: period.days,
        channels: salesChannelIds,
        series: agg.map((r) => ({ day: r.day, orders: r.orders, sum: kopecksToRub(r.sum_kopecks) })),
        groups,
        group_limit: groupLimit,
        group_total: groupTotal,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/funnel?days= — воронка статусов заказов за окно (архив ms_orders). Сам агрегат —
  // дешёвое DB-чтение БЕЗ кэша ответа; живой только словарь имён/цветов (см. loadStatesDict).
  // resolveMs (не resolveMsChannel) сознательно: словарю нужен токен, и «не подключён» здесь
  // отвечает 404 как остальные data-роуты. Строка state_id=NULL (заказы без статуса и строки до
  // повторного прогона бэкфилла) в rows не кладётся — уходит счётчиком no_state_orders.
  app.get('/api/ms/funnel', requireAuth, async (req, res, next) => {
    try {
      const period = parseMsPeriod(req);
      if (period.invalid) return badRange(res);
      const ms = await resolveMs(req, res);
      if (!ms) return;
      // ForActor — канон tenant-read (как days=0 в summary): повторный ownership-чек дёшев.
      const rows = await db.getMsFunnelForActor(ms.channel.id, req.user, {
        sinceDay: period.sinceDay, untilDay: period.untilDay,
      });
      const dict = await loadStatesDict(ms);
      let totalOrders = 0;
      let noStateOrders = 0;
      let noStateSumKopecks = 0;
      const out = [];
      for (const r of rows) {
        totalOrders += r.orders;
        if (r.state_id == null) {
          noStateOrders += r.orders;
          noStateSumKopecks += r.sum_kopecks;
          continue;
        }
        const st = dict ? dict[r.state_id] : null;
        out.push({
          state_id: r.state_id,
          name: st ? st.name : null,
          color: st ? st.color : null,
          orders: r.orders,
          sum: kopecksToRub(r.sum_kopecks),
        });
      }
      res.json({
        window_days: period.days,
        total_orders: totalOrders,
        no_state_orders: noStateOrders,
        no_state_sum: kopecksToRub(noStateSumKopecks),
        rows: out,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/customers?days= — новые vs повторные клиенты за окно (архив ms_orders).
  // Семантика новизны пришпилена в repo: «новый» заказ = ПЕРВЫЙ заказ agent_id за ВСЮ историю
  // канала (не окна). Чистый DB-агрегат — без кэша; суммы наружу в рублях.
  app.get('/api/ms/customers', requireAuth, async (req, res, next) => {
    try {
      const period = parseMsPeriod(req);
      if (period.invalid) return badRange(res);
      const ms = await resolveMs(req, res);
      if (!ms) return;
      const data = await db.getMsCustomersForActor(ms.channel.id, req.user, {
        sinceDay: period.sinceDay, untilDay: period.untilDay,
      });
      // null от ForActor = доступ отозван между resolveMs и чтением (гонка) — честный 403,
      // а не сфабрикованные нули.
      if (!data) return res.status(403).json({ error: 'Нет доступа к этому каналу' });
      const s = data.summary;
      res.json({
        window_days: period.days,
        summary: {
          customers: s.customers,
          new_customers: s.new_customers,
          repeat_customers: s.repeat_customers,
          orders_new: s.orders_new,
          orders_repeat: s.orders_repeat,
          sum_new: kopecksToRub(s.sum_new_kopecks),
          sum_repeat: kopecksToRub(s.sum_repeat_kopecks),
          no_agent_orders: s.no_agent_orders,
          repeat_ever: s.repeat_ever,
        },
        series: data.series.map((row) => ({
          day: row.day,
          new_orders: row.new_orders,
          repeat_orders: row.repeat_orders,
          sum_new: kopecksToRub(row.sum_new_kopecks),
          sum_repeat: kopecksToRub(row.sum_repeat_kopecks),
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/cohorts — когортное удержание по месяцу первого заказа (вся история архива,
  // без параметров — фронт сам обрежет глубину). Чистый DB-агрегат — без кэша; денег в ответе
  // нет, только счётчики клиентов.
  app.get('/api/ms/cohorts', requireAuth, async (req, res, next) => {
    try {
      const ms = await resolveMs(req, res);
      if (!ms) return;
      const cohorts = await db.getMsCohortsForActor(ms.channel.id, req.user);
      res.json({ cohorts });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ms/returns?days= — возвраты покупателей ЖИВЫМ page-loop'ом по /entity/salesreturn
  // (архива возвратов не копим — редкая сущность, счёт/сумма окна снимаются напрямую). Окно и
  // пагинация — как у движка бэкфилла: filter целиком URL-encoded, страницы limit/offset с
  // паузой; days=0 — вся история БЕЗ фильтра. Живые вызовы дорогие → кэш 10 минут.
  app.get('/api/ms/returns', requireAuth, async (req, res, next) => {
    try {
      const period = parseMsPeriod(req);
      if (period.invalid) return badRange(res);
      const ms = await resolveMs(req, res);
      if (!ms) return;
      const cacheKey = `ms:returns:${ms.channel.id}:${period.periodKey}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      // Окно-фильтр из разбора периода (пресет/диапазон); «Всё» (momentFrom=null) — без фильтра.
      let filterQ = '';
      if (period.momentFrom && period.momentTo) {
        filterQ = `filter=${encodeURIComponent(`moment>=${period.momentFrom};moment<=${period.momentTo}`)}&`;
      }
      let count = 0;
      let sumKopecks = 0;
      let truncated = false;
      let offset = 0;
      try {
        for (let page = 0; ; page++) {
          // order=moment,asc — как у движка: детерминированная нарезка страниц между запросами.
          const path = `/entity/salesreturn?${filterQ}order=${encodeURIComponent('moment,asc')}` +
            `&limit=${MS_RETURNS_PAGE_LIMIT}&offset=${offset}`;
          const pageData = await msFetch(ms.token, path);
          const rows = pageData && Array.isArray(pageData.rows) ? pageData.rows : [];
          for (const r of rows) {
            count += 1;
            // Копейки как есть (сумма конвертируется в рубли один раз на выходе); Math.round —
            // страховка от дробной копейки, как в движке.
            sumKopecks += Math.round(Number(r && r.sum) || 0);
          }
          if (rows.length < MS_RETURNS_PAGE_LIMIT) break;          // хвост выборки добран
          if (page + 1 >= MS_RETURNS_PAGE_CAP) { truncated = true; break; }   // упёрлись в cap
          offset += MS_RETURNS_PAGE_LIMIT;
          await sleep(MS_RETURNS_PAGE_PAUSE_MS);
        }
      } catch (e) {
        return sendMsError(res, e, { route: 'returns', channelId: ms.channel.id });
      }
      const data = { window_days: period.days, count, sum: kopecksToRub(sumKopecks), truncated };
      cacheSet(cacheKey, data, MS_RETURNS_CACHE_TTL_MS);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });
}

module.exports = { registerMsRoutes };
