'use strict';

const { hasWorkspaceRole } = require('../middleware/tenant');

/**
 * Роуты Яндекс.Метрики (/api/ym/{connect,status,account,summary,sources,goals,pages,landings,utm}) —
 * серверная половина
 * источника «метрика», зеркально МойСклад-вертикали: connect валидирует OAuth-токен живым
 * identity-вызовом (management/v1/counters) и сохраняет его ТОЛЬКО шифрованным (lib/ym_crypto),
 * data-роуты резолвят канал тем же механизмом (?channel= / заголовок x-channel-id, дефолт через
 * db.getChannelOrDefault — тот же ownership/disabled-предикат) и кэшируются как МС-роуты
 * (дефолтный TTL memoryCache). Токен нигде не логируется и не попадает в ответы/сообщения
 * ошибок (ymClient держит его только в заголовке запроса). days=0 («Всё») в summary
 * строит серии ИЗ АРХИВА ym_daily (его копит jobs/ymCollectionJob), а точные итоги/качество
 * best-effort обогащает одним часовым live-запросом; в sources «Всё» — живой отчёт полного диапазона от даты
 * создания счётчика (кэш 1 час, зеркало top-products «Всё» у МС). Все живые отчёты идут с
 * accuracy=full — сэмплирование Метрики выключено, числа сходятся с архивом.
 * connect/disconnect пишут audit-события ym_connect/ym_disconnect (зеркало ms_connect) —
 * только identity-поля счётчика, токенов в metadata нет.
 */
function registerYmRoutes({ app, requireAuth, db, audit, ymCrypto, ymFetch, cacheGet, cacheSet, cache, log }) {
  // Узкий enum периодов ДО кэш-ключа (канон МС): произвольный days плодил бы per-value
  // кэш-записи ценой upstream-запросов. 0 = «Всё» (summary — архив + best-effort live-итоги;
  // sources — живой полный диапазон). Не-enum → дефолт 30.
  const YM_DAYS_ALLOWED = [0, 7, 30, 90];
  const daysOf = (req) => {
    const n = parseInt(req.query.days, 10);
    return YM_DAYS_ALLOWED.includes(n) ? n : 30;
  };
  // «Всё» у breakdown-роутов (sources/goals/pages/landings/utm) — живой отчёт ПОЛНОГО диапазона счётчика
  // → отдельный кэш 1 час (зеркало MS_TOP_ALL_CACHE_TTL_MS): история меняется медленно,
  // пересобирать чаще дорого.
  const YM_ALL_RANGE_CACHE_TTL_MS = 60 * 60 * 1000;
  // Консервативный якорь «Всё», когда дата создания счётчика неизвестна и архив пуст:
  // раньше любого реального счётчика продукта, лишние пустые годы отчёту Метрики не вредят.
  const YM_ALL_ANCHOR_DAY = '2015-01-01';
  // Разбивка источников — компактный отчёт: типов lastsign-источников у Метрики ~десяток.
  const YM_SOURCES_LIMIT = 50;

  // ── Качество трафика (этот слайс): один summary-запрос со СТАБИЛЬНЫМ порядком метрик ──────────
  // Визиты/посетители/просмотры + отказы, средняя длительность визита, глубина, новые посетители
  // и доля новых. pageDepth берём прямо у Метрики, чтобы не дублировать семантику API сервером.
  // Порядок метрик — контракт: и дневной summary, и all-range totals читают totals по индексам.
  const YM_SUMMARY_METRICS = [
    'ym:s:visits',
    'ym:s:users',
    'ym:s:pageviews',
    'ym:s:bounceRate',
    'ym:s:avgVisitDurationSeconds',
    'ym:s:pageDepth',
    'ym:s:newUsers',
    'ym:s:percentNewVisitors',
  ].join(',');

  const round1 = (n) => Math.round(n * 10) / 10;
  const round2 = (n) => Math.round(n * 100) / 100;
  // Число или null («нет данных» ≠ «0»): доли/средние без знаменателя честно недоступны.
  const numOrNull = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const EMPTY_QUALITY = {
    bounce_rate: null,
    avg_visit_duration_seconds: null,
    page_depth: null,
    new_users: null,
    percent_new_visitors: null,
  };

  // body.totals (порядок = YM_SUMMARY_METRICS) → ТОЧНЫЕ итоги периода + качество, либо null, если
  // totals не пришли. Итоги визитов/посетителей/просмотров тут период-точные (авторитетнее суммы
  // дневных строк): доли/средние Метрики считает по целому периоду, суммировать их по дням нельзя.
  const exactTotalsFromBody = (body) => {
    const t = body && Array.isArray(body.totals) ? body.totals : null;
    // Пустой/частичный totals не делает период «точным»: базовые три итога — минимальный
    // контракт summary. Иначе totals:[] ошибочно включал бы exact_period_totals=true.
    if (!t || t.length < 3) return null;
    const visits = numOrNull(t[0]);
    const users = numOrNull(t[1]);
    const pageviews = numOrNull(t[2]);
    if (visits == null || users == null || pageviews == null) return null;
    const bounce = numOrNull(t[3]);
    const dur = numOrNull(t[4]);
    const pageDepth = numOrNull(t[5]);
    const newUsers = numOrNull(t[6]);
    const pctNew = numOrNull(t[7]);
    return {
      visits,
      users,
      pageviews,
      quality: {
        // При нулевом знаменателе API обычно присылает числовые нули, но для долей/средних это
        // «нет данных», а не измеренное значение. Не показываем пользователю фиктивное качество.
        bounce_rate: visits > 0 && bounce != null ? round2(bounce) : null,
        avg_visit_duration_seconds: visits > 0 && dur != null ? round1(dur) : null,
        page_depth: visits > 0 && pageDepth != null ? round2(pageDepth) : null,
        new_users: newUsers == null ? null : Math.round(newUsers),
        percent_new_visitors: users > 0 && pctNew != null ? round2(pctNew) : null,
      },
    };
  };

  // Верхнеуровневые сэмпл/лаг-поля Reporting API — консервативно, ТОЛЬКО когда реально пришли
  // (UI раскрывает сэмплирование/лаг без шумных бейджей, если полей нет — метаданные молчат).
  const samplingMeta = (body) => {
    const out = {};
    if (!body || typeof body !== 'object') return out;
    if (typeof body.sampled === 'boolean') out.sampled = body.sampled;
    const share = numOrNull(body.sample_share);
    if (share != null) out.sample_share = share;
    const size = numOrNull(body.sample_size);
    if (size != null) out.sample_size = size;
    const space = numOrNull(body.sample_space);
    if (space != null) out.sample_space = space;
    const lag = numOrNull(body.data_lag);
    if (lag != null) out.data_lag = lag;
    return out;
  };

  // base = summaryFromRows(...) (дневные серии + суммарные итоги); exact = exactTotalsFromBody|null.
  // Серии архива/окна НЕ подменяем; точные итоги (когда есть) замещают суммарные, качество — из них.
  const buildSummary = (base, exact, meta) => {
    const out = {
      visits: { total: base.visits.total, series: base.visits.series },
      users: { total: base.users.total, series: base.users.series },
      pageviews: { total: base.pageviews.total, series: base.pageviews.series },
      quality: exact ? exact.quality : { ...EMPTY_QUALITY },
      meta: { exact_period_totals: !!exact, ...meta },
    };
    if (exact) {
      if (exact.visits != null) out.visits.total = Math.round(exact.visits);
      if (exact.users != null) out.users.total = Math.round(exact.users);
      if (exact.pageviews != null) out.pageviews.total = Math.round(exact.pageviews);
    }
    return out;
  };

  // Токен для best-effort «Всё»-обогащения БЕЗ падений: null, если ключ шифрования не настроен,
  // учётки/шифроблоба нет или расшифровка не удалась. Ни ciphertext, ни plaintext в лог не идут.
  const tryReadToken = (acc) => {
    if (!acc || !acc.access_token_enc || !ymCrypto.configured()) return null;
    try {
      return ymCrypto.decrypt(acc.access_token_enc);
    } catch (e) {
      log('warn', 'ym_summary_all_token_unreadable', { error: e && e.message });
      return null;
    }
  };

  // 'YYYY-MM-DD' по местным часам процесса (Railway = UTC) — как остальные дневные окна бэка.
  const fmtDay = (d) => {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
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

  // Единый разбор периода data-роутов: пресет days ЛИБО точный произвольный диапазон
  // (?from&to=YYYY-MM-DD, инклюзивный с обоих концов — окно топбара; фронт всегда шлёт days
  // рядом как пресет-фолбэк). У Метрики окна дневные (date1/date2 без времени), поэтому
  // отдельных moment-границ нет. Возвращает:
  //   invalid=true — from/to присланы, но кривые/перевёрнуты: честный 400;
  //   date1/date2  — инклюзивные дневные границы живых отчётов; оба null у пресета «Всё»;
  //   range        — true для произвольного диапазона (отличает его от days=0 в ветвлениях);
  //   periodKey    — стабильный кэш-токен ('r:from:to' | 'd:days').
  function parseYmPeriod(req) {
    const days = daysOf(req);
    const rawFrom = req.query.from;
    const rawTo = req.query.to;
    if (rawFrom != null || rawTo != null) {
      if (!isDayKey(rawFrom) || !isDayKey(rawTo) || rawFrom > rawTo) {
        return { invalid: true };
      }
      return { invalid: false, range: true, days, date1: rawFrom, date2: rawTo, periodKey: `r:${rawFrom}:${rawTo}` };
    }
    if (days === 0) {
      return { invalid: false, range: false, days, date1: null, date2: null, periodKey: 'd:0' };
    }
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    return { invalid: false, range: false, days, date1: fmtDay(from), date2: fmtDay(now), periodKey: `d:${days}` };
  }
  const badRange = (res) =>
    res.status(400).json({ error: 'Некорректный диапазон дат (ожидается from<=to в формате YYYY-MM-DD)' });

  // Единый маппинг ошибок ymFetch для data-роутов (зеркало sendMsError). 429 (уже ПОСЛЕ одной
  // внутренней повторной попытки клиента) → честный 503 с retry-хинтом. 401/403 от Метрики =
  // токен отозван/права сняты УЖЕ ПОСЛЕ connect'а — отвечаем 401 + машинный code, чтобы UI
  // показал reconnect-CTA. Всё остальное (сеть/5xx) → 502. В лог — только контекст/статус,
  // никогда токен.
  function sendYmError(res, e, ctx) {
    const status = Number(e && e.status) || 0;
    log('warn', 'ym_fetch_failed', { ...ctx, status, error: e && e.message });
    // Квота Метрики: 429 (rate, уже ПОСЛЕ одной внутренней повторной попытки клиента) и 420
    // (documented BLOCK на минуты — клиент его НЕ ретраит) → единый пользовательский 503 с
    // разумным Retry-After. Дефолт заголовка: 420 — минута (блок долгий), 429 — 5с; распарсенный
    // клиентом Retry-After имеет приоритет. Секунды — единица заголовка Retry-After.
    if (status === 420 || status === 429) {
      const fallbackSec = status === 420 ? 60 : 5;
      const maxSec = status === 420 ? 60 * 60 : 60;
      const sec = Number.isFinite(e && e.retryAfterMs)
        ? Math.min(maxSec, Math.max(1, Math.round(e.retryAfterMs / 1000)))
        : fallbackSec;
      res.set('Retry-After', String(sec));
      return res.status(503).json({
        error:
          status === 420
            ? 'Яндекс.Метрика временно заблокировала запросы по квоте — попробуйте через несколько минут'
            : 'Яндекс.Метрика ограничила частоту запросов — попробуйте через несколько секунд',
      });
    }
    if (status === 401 || status === 403) {
      return res.status(401).json({
        error: 'Токен отозван Яндексом — переподключите источник',
        code: 'ym_token_revoked',
      });
    }
    return res.status(502).json({ error: 'Яндекс.Метрика недоступна' });
  }

  // Точечная инвалидация кэша одного канала (ключи `ym:<kind>:<channelId>[:…]`) — connect и
  // отключение переворачивают UI сразу, не пересиживая TTL. Зеркало msCachePurge:
  // delimiter-aware сравнение слота канала, сбой инвалидации никогда не превращает
  // уже-долговечную мутацию интеграции в ложную ошибку (TTL доберёт).
  function ymCachePurge(channelId) {
    if (!channelId) return;
    try {
      if (!cache || typeof cache.keys !== 'function' || typeof cache.delete !== 'function') {
        throw new Error('cache contract has no targeted invalidation');
      }
      const id = String(channelId);
      for (const k of cache.keys()) {
        const parts = k.split(':');
        if (parts[0] === 'ym' && parts[2] === id) cache.delete(k);
      }
    } catch (error) {
      log('warn', 'ym_cache_purge_failed', {
        error: error && error.message ? error.message : 'unknown',
      });
    }
  }

  // Резолв канала запроса + строки ym_accounts БЕЗ расшифровки токена — зеркало
  // resolveMsChannel: явный id без доступа → 403 ВСЕГДА; optional=true (status) смягчает
  // только «не подключён»-исходы. Возвращает { channel, acc } или null (ответ уже отправлен).
  async function resolveYmChannel(req, res, { optional = false } = {}) {
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
      res.status(404).json({ error: 'Яндекс.Метрика не подключена к этому каналу' });
      return null;
    }
    const acc = await db.getYmAccount(channel.id).catch(() => null);
    if (!acc || !acc.access_token_enc) {
      if (optional) return { channel, acc: null };
      res.status(404).json({ error: 'Яндекс.Метрика не подключена к этому каналу' });
      return null;
    }
    return { channel, acc };
  }

  // Пер-запросная идентичность Метрики для live-вызовов (расшифрованный токен + id счётчика).
  // Мок-фолбэка нет: без подключённого счётчика роут честно отвечает 404 и UI показывает
  // connect-CTA. Порядок проверок — канон resolveMs: БД → ключ шифрования → канал/учётка → decrypt.
  async function resolveYm(req, res) {
    if (!db.enabled) {
      res.status(503).json({ error: 'База данных недоступна' });
      return null;
    }
    if (!ymCrypto.configured()) {
      res.status(503).json({ error: 'YM_TOKEN_KEY не задан' });
      return null;
    }
    const resolved = await resolveYmChannel(req, res);
    if (!resolved) return null;
    let token;
    try {
      token = ymCrypto.decrypt(resolved.acc.access_token_enc);
    } catch (e) {
      // Ключ сменили / блоб побит: серверная деградация, а не «не подключён» — честный 503.
      // Ни ciphertext, ни plaintext в лог не попадают (ошибка decrypt — статичная строка node).
      log('warn', 'ym_token_decrypt_failed', { channelId: resolved.channel.id, error: e.message });
      res.status(503).json({ error: 'Не удалось прочитать сохранённый токен Яндекс.Метрики' });
      return null;
    }
    return { channel: resolved.channel, acc: resolved.acc, token };
  }

  // Полный диапазон счётчика для «Всё»-отчётов breakdown-роутов: дата создания счётчика
  // (снята на connect) → фолбэк на старейший день архива → консервативный якорь. Инклюзивно
  // по сегодняшний день.
  async function allRangeWindow(ym, actor) {
    let date1 = ym.acc.counter_created_day;
    if (!date1) {
      const archive = await db.getYmDailyAllForActor(ym.channel.id, actor);
      date1 = (archive[0] && archive[0].day) || YM_ALL_ANCHOR_DAY;
    }
    return { date1, date2: fmtDay(new Date()) };
  }

  // Форма ответа management/v1/counters → безопасные identity-поля счётчика (без токена).
  const siteOf = (c) => {
    if (c && c.site2 && typeof c.site2.site === 'string' && c.site2.site.trim()) return c.site2.site.trim();
    if (c && typeof c.site === 'string' && c.site.trim()) return c.site.trim();
    return null;
  };
  const createdDayOf = (c) => {
    const day = String((c && c.create_time) || '').slice(0, 10);
    return isDayKey(day) ? day : null;
  };

  // POST /api/ym/connect — подключить счётчик Метрики по OAuth-токену. Валидация — живым
  // identity-вызовом (management/v1/counters); при нескольких счётчиках и отсутствии
  // counter_id отвечаем choice_required + список (id/имя/сайт — не секреты), клиент повторяет
  // запрос с выбранным counter_id. Дедуп по counter_id: повторный connect того же счётчика
  // обновляет токен существующего канала.
  app.post('/api/ym/connect', requireAuth, async (req, res, next) => {
    try {
      if (!db.enabled) return res.status(503).json({ error: 'База данных недоступна' });
      if (!ymCrypto.configured()) return res.status(503).json({ error: 'YM_TOKEN_KEY не задан' });
      const token = req.body && typeof req.body.token === 'string' ? req.body.token.trim() : '';
      if (!token) return res.status(400).json({ error: 'Укажи OAuth-токен Яндекса' });
      const wantedId = req.body && req.body.counter_id != null ? String(req.body.counter_id).trim() : '';

      let counters = [];
      try {
        const resp = await ymFetch(token, '/management/v1/counters?per_page=1000');
        counters = resp && Array.isArray(resp.counters) ? resp.counters : [];
      } catch (e) {
        const status = Number(e && e.status) || 0;
        // Токена в e.message нет по построению ymClient — логируем сообщение спокойно.
        log('warn', 'ym_connect_failed', { status, error: e && e.message });
        // Здесь 401/403 = ПРИСЛАННЫЙ токен не подошёл (ошибка ввода) — 400, а не
        // ym_token_revoked (тот про уже сохранённый и отозванный токен в data-роутах).
        if (status === 401 || status === 403) {
          return res.status(400).json({ error: 'Токен отклонён Яндексом' });
        }
        if (status === 429 || status === 420) return sendYmError(res, e, { route: 'connect' });
        return res.status(502).json({ error: 'Яндекс.Метрика недоступна' });
      }
      if (!counters.length) {
        return res.status(400).json({ error: 'На этом аккаунте Яндекса нет счётчиков Метрики' });
      }

      let counter = null;
      if (wantedId) {
        counter = counters.find((c) => String(c && c.id) === wantedId) || null;
        // Счётчик вне списка токена = ошибка ввода/чужой id — не раскрываем ничего лишнего.
        if (!counter) return res.status(400).json({ error: 'Счётчик недоступен этому токену' });
      } else if (counters.length === 1) {
        counter = counters[0];
      } else {
        // Несколько счётчиков: отдаём выбор клиенту (id/имя/сайт — витринные identity-поля).
        return res.json({
          ok: false,
          choice_required: true,
          counters: counters.slice(0, YM_SOURCES_LIMIT).map((c) => ({
            id: String(c.id),
            name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : null,
            site: siteOf(c),
          })),
        });
      }

      const counterId = String(counter.id);
      const counterName = typeof counter.name === 'string' && counter.name.trim() ? counter.name.trim() : null;
      const site = siteOf(counter);
      let channelId = await db.findYmChannelByCounter(req.user.uid, counterId);
      if (!channelId) {
        const created = await db.createYmChannel({ owner_uid: req.user.uid, name: counterName || site });
        if (!created) return res.status(503).json({ error: 'Не удалось создать канал' });
        channelId = created.id;
      }
      await db.saveYmAccount(channelId, {
        counter_id: counterId,
        counter_name: counterName,
        site,
        counter_created_day: createdDayOf(counter),
        access_token_enc: ymCrypto.encrypt(token),
      });
      // Ротация токена/пере-connect существующего канала: старые ym:*-ответы могли быть
      // собраны умершим токеном — сбрасываем сразу (для свежего канала purge — no-op).
      ymCachePurge(channelId);
      // Аудит подключения (зеркало ms_connect): только identity-поля счётчика. Токена в
      // metadata нет и быть не может: audit-строки живут год.
      await audit(req, 'ym_connect', { channelId, counterId, counterName });
      res.json({ ok: true, channel_id: channelId, counter_name: counterName, site });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ym/status — состояние подключения для Settings/connect-CTA. Без 404 при
  // отсутствии учётки и без расшифровки токена: connected — это «строка ym_accounts
  // существует», ничего секретного наружу.
  app.get('/api/ym/status', requireAuth, async (req, res, next) => {
    try {
      const resolved = await resolveYmChannel(req, res, { optional: true });
      if (!resolved) return;
      res.json({
        connected: !!resolved.acc,
        counter_name: resolved.acc ? resolved.acc.counter_name || null : null,
        counter_id: resolved.acc ? resolved.acc.counter_id || null : null,
        site: resolved.acc ? resolved.acc.site || null : null,
      });
    } catch (e) {
      next(e);
    }
  });

  // DELETE /api/ym/account — отключить Метрику от канала. Сносится ТОЛЬКО учётка (токен);
  // канал и архив ym_daily живут дальше (история остаётся, повторный connect её продолжит).
  // Идемпотентно: повторный DELETE без учётки — тот же { ok:true }. Отключение — admin-действие
  // воркспейса (зеркало DELETE /api/ms/account).
  app.delete('/api/ym/account', requireAuth, async (req, res, next) => {
    try {
      const resolved = await resolveYmChannel(req, res, { optional: true });
      if (!resolved) return;
      if (!resolved.channel) {
        return res.status(404).json({ error: 'Яндекс.Метрика не подключена к этому каналу' });
      }
      if (!hasWorkspaceRole(resolved.channel, req.user, 'admin')) {
        return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      }
      await db.deleteYmAccount(resolved.channel.id);
      // Кэш-ответы канала собраны отозванным подключением — выкидываем сразу, а не по TTL.
      ymCachePurge(resolved.channel.id);
      await audit(req, 'ym_disconnect', {
        channelId: resolved.channel.id,
        counterId: (resolved.acc && resolved.acc.counter_id) || null,
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Отчёт «по дням» → плотные дневные серии окна [date1..date2]: строки Метрики есть только у
  // дней С трафиком, поэтому окно дозаполняется нулями (зеркало плотного plotseries у МС) —
  // график честно показывает провалы, а не сжимает ось. Кривые дни отбрасываются (канон dayOf).
  function reportToDailySeries(body, date1, date2) {
    const byDay = new Map();
    const rows = body && Array.isArray(body.data) ? body.data : [];
    for (const row of rows) {
      const dim = row && Array.isArray(row.dimensions) && row.dimensions[0];
      const day = dim && typeof dim.name === 'string' ? dim.name.slice(0, 10) : '';
      if (!isDayKey(day)) continue;
      const m = row && Array.isArray(row.metrics) ? row.metrics : [];
      byDay.set(day, {
        visits: Math.round(Number(m[0]) || 0),
        users: Math.round(Number(m[1]) || 0),
        pageviews: Math.round(Number(m[2]) || 0),
      });
    }
    const series = [];
    // Итерация дней в UTC-полднях — DST-безопасно; границы уже проверены isDayKey.
    let cursor = Date.parse(`${date1}T12:00:00Z`);
    const end = Date.parse(`${date2}T12:00:00Z`);
    while (cursor <= end) {
      const day = new Date(cursor).toISOString().slice(0, 10);
      const row = byDay.get(day) || { visits: 0, users: 0, pageviews: 0 };
      series.push({ day, ...row });
      cursor += 24 * 60 * 60 * 1000;
    }
    return series;
  }

  // Дневные строки (архив или живой отчёт) → форма ответа summary: три метрики с итогами.
  // Посетители СОЗНАТЕЛЬНО суммируются по дням: сумма дневных уникальных посетителей — не
  // «уникальные за период» (тот считается только целым отчётом), подпись у фронта это отражает.
  function summaryFromRows(rows) {
    let visits = 0;
    let users = 0;
    let pageviews = 0;
    const vSeries = [];
    const uSeries = [];
    const pSeries = [];
    for (const r of rows) {
      const v = Number(r.visits) || 0;
      const u = Number(r.users) || 0;
      const p = Number(r.pageviews) || 0;
      visits += v;
      users += u;
      pageviews += p;
      vSeries.push({ day: r.day, value: v });
      uSeries.push({ day: r.day, value: u });
      pSeries.push({ day: r.day, value: p });
    }
    return {
      visits: { total: visits, series: vSeries },
      users: { total: users, series: uSeries },
      pageviews: { total: pageviews, series: pSeries },
    };
  }

  // GET /api/ym/summary?days=30 — визиты/посетители/просмотры дневными сериями + качество трафика
  // за окно. Конечные окна (7/30/90/диапазон) берут ТОЧНЫЕ итоги периода из body.totals одного
  // запроса; days=0 («Всё») рисует базовые серии из архива ym_daily и best-effort обогащает
  // качество одним живым all-range totals-запросом (кэш 1 час), честно деградируя без токена.
  app.get('/api/ym/summary', requireAuth, async (req, res, next) => {
    try {
      const period = parseYmPeriod(req);
      if (period.invalid) return badRange(res);

      if (period.days === 0 && !period.range) {
        // Архивная ветка: канал резолвим и 404-им как data-роут (после отключения учётки «Всё»
        // ведёт себя как остальные периоды — connect-CTA). Базовые серии/итоги — только из БД.
        const resolved = await resolveYmChannel(req, res);
        if (!resolved) return;
        // ForActor — канон tenant-read; повторный ownership-чек поверх resolveYmChannel дёшев.
        const rows = await db.getYmDailyAllForActor(resolved.channel.id, req.user);
        const base = summaryFromRows(rows);
        const archiveLastDay = rows.length ? rows[rows.length - 1].day : null;

        // Живое обогащение «Всё»: ТОЧНЫЕ итоги + качество одним all-range totals-запросом, кэш
        // 1 час (зеркало часового кэша breakdown-«Всё»). Токен/ключ недоступен ИЛИ запрос упал →
        // архив рендерится честно, качество = null, meta.exact_period_totals=false. Серии архива
        // при этом НИКОГДА не подменяются.
        let exact = null;
        let sampling = {};
        const enrichKey = `ym:summary-all-live:${resolved.channel.id}`;
        const cachedEnrich = cacheGet(enrichKey);
        if (cachedEnrich) {
          exact = cachedEnrich.exact;
          sampling = cachedEnrich.sampling;
        } else {
          const token = tryReadToken(resolved.acc);
          if (token) {
            try {
              const { date1, date2 } = await allRangeWindow(resolved, req.user);
              // No-dim all-range запрос: значения живут в body.totals (стабильный порядок метрик).
              const body = await ymFetch(
                token,
                `/stat/v1/data?ids=${encodeURIComponent(resolved.acc.counter_id)}` +
                  `&metrics=${YM_SUMMARY_METRICS}` +
                  `&date1=${date1}&date2=${date2}` +
                  '&limit=1&accuracy=full',
              );
              exact = exactTotalsFromBody(body);
              sampling = samplingMeta(body);
              cacheSet(enrichKey, { exact, sampling }, YM_ALL_RANGE_CACHE_TTL_MS);
            } catch (e) {
              // Никакого 5xx на весь summary: честный архив лучше пустой ошибки. Контекст без токена.
              log('warn', 'ym_summary_all_enrich_failed', {
                channelId: resolved.channel.id,
                status: Number(e && e.status) || 0,
              });
              exact = null;
              // Короткий negative-cache не даёт каждой перезагрузке страницы повторно долбить
              // уже упавший live-отчёт. Для квоты уважаем Retry-After (с потолком 5 минут),
              // для сети/5xx даём 30 секунд; архивный ответ всё это время остаётся доступен.
              const failureTtl = Number.isFinite(e && e.retryAfterMs)
                ? Math.min(5 * 60 * 1000, Math.max(1000, e.retryAfterMs))
                : 30 * 1000;
              cacheSet(enrichKey, { exact: null, sampling: {} }, failureTtl);
            }
          }
        }
        const data = buildSummary(base, exact, { all_time: true, archive_last_day: archiveLastDay, ...sampling });
        return res.json(data);
      }

      const ym = await resolveYm(req, res);
      if (!ym) return;
      const cacheKey = `ym:summary:${ym.channel.id}:${period.periodKey}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      let body;
      try {
        body = await ymFetch(
          ym.token,
          `/stat/v1/data?ids=${encodeURIComponent(ym.acc.counter_id)}` +
            `&metrics=${YM_SUMMARY_METRICS}` +
            '&dimensions=ym:s:date&sort=ym:s:date' +
            `&date1=${period.date1}&date2=${period.date2}` +
            '&limit=100000&accuracy=full',
        );
      } catch (e) {
        return sendYmError(res, e, { route: 'summary', channelId: ym.channel.id });
      }
      // Серии — из дневных строк (первые три метрики visits/users/pageviews); ТОЧНЫЕ итоги
      // периода — из body.totals (не пересуммируем дни). totals нет → падаем на суммы дней.
      const base = summaryFromRows(reportToDailySeries(body, period.date1, period.date2));
      const exact = exactTotalsFromBody(body);
      const data = buildSummary(base, exact, {
        all_time: false,
        archive_last_day: null,
        ...samplingMeta(body),
      });
      cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ym/sources?days=30 — разбивка визитов/посетителей по источникам трафика
  // (ym:s:lastsignTrafficSource, атрибуция «последний значимый»). Всегда живой отчёт (компактный,
  // один запрос); «Всё» — полный диапазон от даты создания счётчика (фолбэк — старейший день
  // архива, затем консервативный якорь) с часовым кэшем. lang=ru — русские имена источников.
  app.get('/api/ym/sources', requireAuth, async (req, res, next) => {
    try {
      const period = parseYmPeriod(req);
      if (period.invalid) return badRange(res);
      const ym = await resolveYm(req, res);
      if (!ym) return;
      const cacheKey = `ym:sources:${ym.channel.id}:${period.periodKey}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      const isAll = period.days === 0 && !period.range;
      const { date1, date2 } = isAll
        ? await allRangeWindow(ym, req.user)
        : { date1: period.date1, date2: period.date2 };

      let body;
      try {
        body = await ymFetch(
          ym.token,
          `/stat/v1/data?ids=${encodeURIComponent(ym.acc.counter_id)}` +
            '&metrics=ym:s:visits,ym:s:users' +
            '&dimensions=ym:s:lastsignTrafficSource&sort=-ym:s:visits' +
            `&date1=${date1}&date2=${date2}` +
            `&limit=${YM_SOURCES_LIMIT}&accuracy=full&lang=ru`,
        );
      } catch (e) {
        return sendYmError(res, e, { route: 'sources', channelId: ym.channel.id });
      }

      const rows = (body && Array.isArray(body.data) ? body.data : [])
        .map((row) => {
          const dim = row && Array.isArray(row.dimensions) && row.dimensions[0];
          const m = row && Array.isArray(row.metrics) ? row.metrics : [];
          return {
            id: dim && dim.id != null ? String(dim.id) : null,
            name: dim && typeof dim.name === 'string' && dim.name ? dim.name : null,
            visits: Math.round(Number(m[0]) || 0),
            users: Math.round(Number(m[1]) || 0),
          };
        })
        .filter((r) => r.id != null || r.name != null);
      // totals Метрики = итог ПОЛНОГО отчёта (не среза limit) — авторитетнее суммы строк;
      // фолбэк на сумму, если форма ответа неожиданная.
      const totals = body && Array.isArray(body.totals) ? body.totals : [];
      const visitsTotal = Number.isFinite(Number(totals[0]))
        ? Math.round(Number(totals[0]))
        : rows.reduce((acc, r) => acc + r.visits, 0);
      const usersTotal = Number.isFinite(Number(totals[1]))
        ? Math.round(Number(totals[1]))
        : rows.reduce((acc, r) => acc + r.users, 0);
      const data = { visits_total: visitsTotal, users_total: usersTotal, rows };
      cacheSet(cacheKey, data, isAll ? YM_ALL_RANGE_CACHE_TTL_MS : undefined);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // ── Цели (слайс 2): management-словарь + reaches/conversionRate батчами ─────────────────────
  // Словарь целей меняется редко → часовой кэш (канон словарей МС); НЕуспех словаря не
  // кэшируется. id целей проходят строгий числовой гейт ДО вклейки в имена метрик
  // (ym:s:goal<id>reaches) — произвольная строка в metrics-параметр не попадает по построению.
  const YM_GOALS_DICT_CACHE_TTL_MS = 60 * 60 * 1000;
  // Потолок целей отчёта: 2 батча по 10 целей (пара reaches+conversionRate на цель = 20 метрик,
  // лимит API на запрос). Больше 20 осмысленных целей — экзотика; честный truncated-флаг.
  const YM_GOALS_MAX = 20;
  const YM_GOALS_BATCH = 10;

  async function loadGoalsDict(ym) {
    const cacheKey = `ym:goals-dict:${ym.channel.id}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const body = await ymFetch(
      ym.token,
      `/management/v1/counter/${encodeURIComponent(ym.acc.counter_id)}/goals`,
    );
    const goals = (body && Array.isArray(body.goals) ? body.goals : [])
      .map((g) => ({
        id: Number(g && g.id),
        name: g && typeof g.name === 'string' && g.name.trim() ? g.name.trim() : null,
      }))
      .filter((g) => Number.isSafeInteger(g.id) && g.id > 0);
    cacheSet(cacheKey, goals, YM_GOALS_DICT_CACHE_TTL_MS);
    return goals;
  }

  // GET /api/ym/goals?days=30 — достижения целей за окно: reaches (все достижения) +
  // conversionRate (% визитов с достижением; из reaches НЕ выводится — отдельная метрика).
  // Сортировка по reaches — у себя: метрики здесь колонки totals, а не строки отчёта.
  app.get('/api/ym/goals', requireAuth, async (req, res, next) => {
    try {
      const period = parseYmPeriod(req);
      if (period.invalid) return badRange(res);
      const ym = await resolveYm(req, res);
      if (!ym) return;
      const cacheKey = `ym:goals:${ym.channel.id}:${period.periodKey}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const isAll = period.days === 0 && !period.range;

      let goals;
      try {
        goals = await loadGoalsDict(ym);
      } catch (e) {
        return sendYmError(res, e, { route: 'goals-dict', channelId: ym.channel.id });
      }
      if (!goals.length) {
        const data = { rows: [], truncated: false };
        cacheSet(cacheKey, data, isAll ? YM_ALL_RANGE_CACHE_TTL_MS : undefined);
        return res.json(data);
      }

      const { date1, date2 } = isAll
        ? await allRangeWindow(ym, req.user)
        : { date1: period.date1, date2: period.date2 };
      const take = goals.slice(0, YM_GOALS_MAX);
      const chunks = [];
      for (let i = 0; i < take.length; i += YM_GOALS_BATCH) chunks.push(take.slice(i, i + YM_GOALS_BATCH));
      const byGoal = new Map();
      try {
        const results = await Promise.all(chunks.map((chunk) => ymFetch(
          ym.token,
          `/stat/v1/data?ids=${encodeURIComponent(ym.acc.counter_id)}` +
            `&metrics=${chunk.map((g) => `ym:s:goal${g.id}reaches,ym:s:goal${g.id}conversionRate`).join(',')}` +
            `&date1=${date1}&date2=${date2}&accuracy=full`,
        )));
        // Без dimensions значения живут в totals (выровнены по порядку metrics); data может быть
        // пустым при нулевом окне — totals есть всегда, ||0 закрывает и неожиданную форму.
        results.forEach((body, ci) => {
          const totals = body && Array.isArray(body.totals) ? body.totals : [];
          chunks[ci].forEach((g, gi) => {
            byGoal.set(g.id, {
              reaches: Math.round(Number(totals[gi * 2]) || 0),
              conversion_rate: Math.round((Number(totals[gi * 2 + 1]) || 0) * 100) / 100,
            });
          });
        });
      } catch (e) {
        return sendYmError(res, e, { route: 'goals', channelId: ym.channel.id });
      }
      const rows = take
        .map((g) => ({ id: String(g.id), name: g.name, ...byGoal.get(g.id) }))
        .sort((a, b) => b.reaches - a.reaches || a.id.localeCompare(b.id));
      const data = { rows, truncated: goals.length > YM_GOALS_MAX };
      cacheSet(cacheKey, data, isAll ? YM_ALL_RANGE_CACHE_TTL_MS : undefined);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // ── Топ-страницы (слайс 2): hits-неймспейс ym:pv (просмотры страниц, не визиты) ─────────────
  const YM_PAGES_LIMIT_DEFAULT = 10;
  const YM_PAGES_LIMIT_MAX = 50;
  const pagesLimitOf = (req) => {
    const n = parseInt(req.query.limit, 10);
    if (!Number.isFinite(n) || n < 1) return YM_PAGES_LIMIT_DEFAULT;
    return Math.min(n, YM_PAGES_LIMIT_MAX);
  };

  // GET /api/ym/pages?days=30&limit=10 — страницы по просмотрам (ym:pv:URLPath: путь без
  // домена/query — читаемая identity страницы). totals — итог полного отчёта для хвоста «из M».
  app.get('/api/ym/pages', requireAuth, async (req, res, next) => {
    try {
      const period = parseYmPeriod(req);
      if (period.invalid) return badRange(res);
      const limit = pagesLimitOf(req);
      const ym = await resolveYm(req, res);
      if (!ym) return;
      const cacheKey = `ym:pages:${ym.channel.id}:${period.periodKey}:${limit}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const isAll = period.days === 0 && !period.range;
      const { date1, date2 } = isAll
        ? await allRangeWindow(ym, req.user)
        : { date1: period.date1, date2: period.date2 };

      let body;
      try {
        body = await ymFetch(
          ym.token,
          `/stat/v1/data?ids=${encodeURIComponent(ym.acc.counter_id)}` +
            '&metrics=ym:pv:pageviews,ym:pv:users' +
            '&dimensions=ym:pv:URLPath&sort=-ym:pv:pageviews' +
            `&date1=${date1}&date2=${date2}` +
            `&limit=${limit}&accuracy=full`,
        );
      } catch (e) {
        return sendYmError(res, e, { route: 'pages', channelId: ym.channel.id });
      }

      const rows = (body && Array.isArray(body.data) ? body.data : [])
        .map((row) => {
          const dim = row && Array.isArray(row.dimensions) && row.dimensions[0];
          const m = row && Array.isArray(row.metrics) ? row.metrics : [];
          return {
            path: dim && typeof dim.name === 'string' && dim.name ? dim.name : null,
            pageviews: Math.round(Number(m[0]) || 0),
            users: Math.round(Number(m[1]) || 0),
          };
        })
        .filter((r) => r.path != null);
      const totals = body && Array.isArray(body.totals) ? body.totals : [];
      const pageviewsTotal = Number.isFinite(Number(totals[0]))
        ? Math.round(Number(totals[0]))
        : rows.reduce((acc, r) => acc + r.pageviews, 0);
      const data = { pageviews_total: pageviewsTotal, rows };
      cacheSet(cacheKey, data, isAll ? YM_ALL_RANGE_CACHE_TTL_MS : undefined);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // ── Лендинги (слайс качества): разбивка по СТРАНИЦЕ ВХОДА ─────────────────────────────────────
  // ym:s:startURLPath (путь входа без query — не PathFull: query-строки плодят кардинальность и
  // тянут PII). Визиты/посетители/отказы по странице входа + опционально достижения и конверсия
  // ОДНОЙ выбранной цели. goal_id проходит строгий числовой гейт ДО сборки имён метрик: любая
  // не-число/не-положительная строка (инъекция) отбрасывается и наружу в metrics не попадает.
  const YM_LANDINGS_LIMIT_DEFAULT = 10;
  const YM_LANDINGS_LIMIT_MAX = 50;
  const landingsLimitOf = (req) => {
    const n = parseInt(req.query.limit, 10);
    if (!Number.isFinite(n) || n < 1) return YM_LANDINGS_LIMIT_DEFAULT;
    return Math.min(n, YM_LANDINGS_LIMIT_MAX);
  };
  // Опциональный goal_id: положительный safe-integer ЛИБО ничего. Иное (инъекция, дробь,
  // отрицательное, переполнение) → null: цель просто не запрашивается, отчёт остаётся базовым.
  const goalIdOf = (req) => {
    const raw = req.query.goal_id;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };

  // GET /api/ym/landings?days=30&limit=10&goal_id=<id?> — топ страниц входа по визитам.
  app.get('/api/ym/landings', requireAuth, async (req, res, next) => {
    try {
      const period = parseYmPeriod(req);
      if (period.invalid) return badRange(res);
      const limit = landingsLimitOf(req);
      const goalId = goalIdOf(req);
      const ym = await resolveYm(req, res);
      if (!ym) return;
      // Кэш scoping: канал + период + limit + цель (g0 — без цели).
      const cacheKey = `ym:landings:${ym.channel.id}:${period.periodKey}:${limit}:g${goalId || 0}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const isAll = period.days === 0 && !period.range;
      const { date1, date2 } = isAll
        ? await allRangeWindow(ym, req.user)
        : { date1: period.date1, date2: period.date2 };

      // goalId — уже число (или null): интерполяция в имена метрик инъекционно-безопасна.
      let metrics = 'ym:s:visits,ym:s:users,ym:s:bounceRate';
      if (goalId != null) metrics += `,ym:s:goal${goalId}reaches,ym:s:goal${goalId}conversionRate`;

      let body;
      try {
        body = await ymFetch(
          ym.token,
          `/stat/v1/data?ids=${encodeURIComponent(ym.acc.counter_id)}` +
            `&metrics=${metrics}` +
            '&dimensions=ym:s:startURLPath&sort=-ym:s:visits' +
            `&date1=${date1}&date2=${date2}` +
            `&limit=${limit}&accuracy=full`,
        );
      } catch (e) {
        return sendYmError(res, e, { route: 'landings', channelId: ym.channel.id });
      }

      const rows = (body && Array.isArray(body.data) ? body.data : [])
        .map((row) => {
          const dim = row && Array.isArray(row.dimensions) && row.dimensions[0];
          const m = row && Array.isArray(row.metrics) ? row.metrics : [];
          const r = {
            path: dim && typeof dim.name === 'string' && dim.name ? dim.name : null,
            visits: Math.round(Number(m[0]) || 0),
            users: Math.round(Number(m[1]) || 0),
            bounce_rate: numOrNull(m[2]) == null ? null : round2(numOrNull(m[2])),
          };
          if (goalId != null) {
            r.goal_reaches = Math.round(Number(m[3]) || 0);
            r.goal_conversion = numOrNull(m[4]) == null ? null : round2(numOrNull(m[4]));
          }
          return r;
        })
        .filter((r) => r.path != null);
      // totals = итог ПОЛНОГО отчёта (не среза limit) — для хвоста «из M визитов».
      const totals = body && Array.isArray(body.totals) ? body.totals : [];
      const visitsTotal = Number.isFinite(Number(totals[0]))
        ? Math.round(Number(totals[0]))
        : rows.reduce((acc, r) => acc + r.visits, 0);
      const data = { goal_id: goalId, visits_total: visitsTotal, rows, meta: samplingMeta(body) };
      cacheSet(cacheKey, data, isAll ? YM_ALL_RANGE_CACHE_TTL_MS : undefined);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ym/utm?days=30 — визиты/посетители по utm_source. Визиты БЕЗ метки не прячутся и
  // не смешиваются с размеченными: null-строка отчёта уходит в untagged_visits (сноска UI), в
  // rows остаются только размеченные источники. tagged = total − untagged (арифметика полного
  // отчёта, а не суммы среза limit). lang не нужен: значения — сырые utm-строки.
  app.get('/api/ym/utm', requireAuth, async (req, res, next) => {
    try {
      const period = parseYmPeriod(req);
      if (period.invalid) return badRange(res);
      const ym = await resolveYm(req, res);
      if (!ym) return;
      const cacheKey = `ym:utm:${ym.channel.id}:${period.periodKey}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const isAll = period.days === 0 && !period.range;
      const { date1, date2 } = isAll
        ? await allRangeWindow(ym, req.user)
        : { date1: period.date1, date2: period.date2 };

      let body;
      try {
        body = await ymFetch(
          ym.token,
          `/stat/v1/data?ids=${encodeURIComponent(ym.acc.counter_id)}` +
            '&metrics=ym:s:visits,ym:s:users' +
            '&dimensions=ym:s:UTMSource&sort=-ym:s:visits' +
            `&date1=${date1}&date2=${date2}` +
            `&limit=${YM_SOURCES_LIMIT}&accuracy=full`,
        );
      } catch (e) {
        return sendYmError(res, e, { route: 'utm', channelId: ym.channel.id });
      }

      const mapped = (body && Array.isArray(body.data) ? body.data : []).map((row) => {
        const dim = row && Array.isArray(row.dimensions) && row.dimensions[0];
        const m = row && Array.isArray(row.metrics) ? row.metrics : [];
        return {
          id: dim && dim.id != null ? String(dim.id) : null,
          name: dim && typeof dim.name === 'string' && dim.name ? dim.name : null,
          visits: Math.round(Number(m[0]) || 0),
          users: Math.round(Number(m[1]) || 0),
        };
      });
      const rows = mapped.filter((r) => r.id != null || r.name != null);
      const untagged = mapped.find((r) => r.id == null && r.name == null);
      const untaggedVisits = untagged ? untagged.visits : 0;
      const totals = body && Array.isArray(body.totals) ? body.totals : [];
      const visitsTotal = Number.isFinite(Number(totals[0]))
        ? Math.round(Number(totals[0]))
        : mapped.reduce((acc, r) => acc + r.visits, 0);
      const data = {
        visits_total: visitsTotal,
        tagged_visits: Math.max(0, visitsTotal - untaggedVisits),
        untagged_visits: untaggedVisits,
        rows,
      };
      cacheSet(cacheKey, data, isAll ? YM_ALL_RANGE_CACHE_TTL_MS : undefined);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });
}

module.exports = { registerYmRoutes };
