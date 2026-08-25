'use strict';

const { hasWorkspaceRole } = require('../middleware/tenant');
const { parseCdekPeriod } = require('../domain/cdekPeriod');
const { normalizeCdekInclude } = require('../repos/cdekRepo');

/**
 * Роуты СДЭК Fulfillment (/api/cdek/{sources,status,import,imports,imports/:id,
 * imports/:id/rejected.csv,imports/:id/replay}) — серверная половина первого источника БЕЗ API.
 *
 * Загрузка идёт СЫРЫМ телом (`express.raw`) с именем файла в заголовке `x-filename`: multipart
 * потребовал бы отдельной зависимости ради одного поля, а заголовок — тот же приём, что у
 * ingest-токена коллектора. Файл кладётся в БД целиком (прецедент bug_attachments), чтобы импорт
 * можно было переиграть, когда уточнятся правила классификации строк.
 *
 * Разбор синхронный: годовая выгрузка склада — 1126 строк, это десятки миллисекунд. Потолок
 * размера и числа строк держит роут; при первом же файле, который в него не влезет, разбор
 * переедет в jobs — контракт ответа для этого менять не придётся.
 *
 * Канал резолвится тем же механизмом, что у МойСклада и IG (?channel= / заголовок x-channel-id,
 * дефолт через db.getChannelOrDefault с его ownership-предикатом). Запись (создание источника,
 * загрузка, переигровка) дополнительно требует роли admin в воркспейсе: импорт переписывает
 * общий архив, и это не операция уровня «посмотреть».
 */
function registerCdekRoutes({ app, express, requireAuth, db, audit, cdekImport }) {
  // 10 МБ на файл: годовая выгрузка весит ~110 КБ, то есть запас стократный. Кап нужен не
  // против больших складов, а против того, чтобы БД не приняла произвольный блоб.
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  const rawBody = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

  async function resolveCdekChannel(req, res, { role = null } = {}) {
    if (!db.enabled) {
      res.status(503).json({ error: 'База данных недоступна' });
      return null;
    }
    const channelId = parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
    const channel = await db.getChannelOrDefault(channelId, req.user).catch(() => null);
    if (!channel) {
      res.status(channelId ? 403 : 404).json({
        error: channelId ? 'Нет доступа к этому каналу' : 'Источник СДЭК не найден',
      });
      return null;
    }
    if (channel.source !== 'cdek') {
      res.status(404).json({ error: 'Это не источник СДЭК' });
      return null;
    }
    if (role && !hasWorkspaceRole(channel, req.user, role)) {
      res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      return null;
    }
    return channel;
  }

  /** Ошибка разбора несёт userMessage — это сообщение пользователю, а не внутренняя пятисотка. */
  function sendImportError(res, e) {
    const status = Number(e && e.status) || (e && e.userMessage ? 422 : 500);
    if (status >= 500) return null;
    res.status(status).json({ error: e.userMessage || e.message });
    return true;
  }

  // POST /api/cdek/sources — завести источник. Ничего не подключает: у выгрузки нет ни токена,
  // ни идентичности, по которой её можно узнать, — источник существует потому, что его создали.
  app.post('/api/cdek/sources', requireAuth, async (req, res, next) => {
    try {
      if (!db.enabled) return res.status(503).json({ error: 'База данных недоступна' });
      const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
      const tz = req.body && typeof req.body.tz === 'string' && req.body.tz.trim()
        ? req.body.tz.trim() : 'Europe/Moscow';
      // Зона проверяется здесь: с непонятной зоной AT TIME ZONE в импорте упадёт уже внутри
      // транзакции, и пользователь увидит пятисотку вместо «неизвестный часовой пояс».
      try {
        new Intl.DateTimeFormat('ru-RU', { timeZone: tz });
      } catch {
        return res.status(400).json({ error: 'Неизвестный часовой пояс' });
      }
      const created = await db.createCdekChannel({ owner_uid: req.user.uid, name: name || 'СДЭК' });
      if (!created) return res.status(503).json({ error: 'Не удалось создать источник' });
      await db.saveCdekSource(created.id, { tz, title: created.title });
      await audit(req, 'cdek_source_create', { channelId: created.id, title: created.title, tz });
      res.json({ ok: true, channel_id: created.id, title: created.title, tz });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/cdek/status — состояние источника для витрины: склад, зона и последний импорт.
  app.get('/api/cdek/status', requireAuth, async (req, res, next) => {
    try {
      const channel = await resolveCdekChannel(req, res);
      if (!channel) return;
      const [source, imports] = await Promise.all([
        db.getCdekSource(channel.id),
        db.listCdekImports(channel.id, 1),
      ]);
      res.json({
        channel_id: channel.id,
        title: channel.title,
        warehouse_code: source ? source.warehouse_code : null,
        tz: source ? source.tz : null,
        last_import: imports[0] || null,
      });
    } catch (e) {
      next(e);
    }
  });

  // POST /api/cdek/import — загрузка выгрузки. Тело — сырые байты файла.
  app.post('/api/cdek/import', requireAuth, rawBody, async (req, res, next) => {
    try {
      const channel = await resolveCdekChannel(req, res, { role: 'admin' });
      if (!channel) return;
      const buffer = Buffer.isBuffer(req.body) ? req.body : null;
      if (!buffer || !buffer.length) return res.status(400).json({ error: 'Пустой файл' });
      // Имя приезжает percent-encoded: кириллица в HTTP-заголовке недопустима. Битую
      // последовательность не роняем на пользователя — берём как есть.
      const rawName = String(req.headers['x-filename'] || 'выгрузка.xlsx');
      let filename;
      try {
        filename = decodeURIComponent(rawName);
      } catch {
        filename = rawName;
      }
      filename = filename.slice(0, 200);

      const result = await cdekImport.importFile({
        channelId: channel.id,
        uid: req.user.uid,
        filename,
        buffer,
      });
      if (result.duplicate) {
        // Не ошибка: пользователь загрузил тот же файл повторно. Отвечаем 200 с прежним отчётом,
        // чтобы витрина показала, когда и с каким результатом он уже приезжал.
        return res.json({ ok: true, duplicate: true, import: result.import });
      }
      await audit(req, 'cdek_import', {
        channelId: channel.id,
        importId: result.import && result.import.id,
        filename,
        rows: result.import && result.import.rows_total,
      });
      res.json({ ok: true, duplicate: false, import: result.import });
    } catch (e) {
      if (sendImportError(res, e)) return;
      next(e);
    }
  });

  app.get('/api/cdek/imports', requireAuth, async (req, res, next) => {
    try {
      const channel = await resolveCdekChannel(req, res);
      if (!channel) return;
      res.json({ imports: await db.listCdekImports(channel.id, req.query.limit) });
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/cdek/imports/:id', requireAuth, async (req, res, next) => {
    try {
      const channel = await resolveCdekChannel(req, res);
      if (!channel) return;
      const row = await db.getCdekImport(channel.id, parseInt(req.params.id, 10) || 0);
      if (!row) return res.status(404).json({ error: 'Импорт не найден' });
      res.json({ import: row });
    } catch (e) {
      next(e);
    }
  });

  // Отвергнутые строки выгружаются файлом: их чинят в Excel, а не читают с экрана.
  app.get('/api/cdek/imports/:id/rejected.csv', requireAuth, async (req, res, next) => {
    try {
      const channel = await resolveCdekChannel(req, res);
      if (!channel) return;
      const row = await db.getCdekImport(channel.id, parseInt(req.params.id, 10) || 0);
      if (!row) return res.status(404).json({ error: 'Импорт не найден' });
      const rows = Array.isArray(row.rejected) ? row.rejected : [];
      // Экранирование CSV-инъекции: значение, начинающееся с =/+/-/@, Excel исполнит как формулу.
      const cell = (v) => {
        const s = String(v == null ? '' : v);
        const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const csv = ['Строка;Заказ;Причина']
        .concat(rows.map((r) => [cell(r.row), cell(r.order_id), cell(r.reason)].join(';')))
        .join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="cdek-rejected-${row.id}.csv"`);
      // BOM — иначе Excel в русской локали откроет utf-8 как windows-1251.
      res.send(`﻿${csv}`);
    } catch (e) {
      next(e);
    }
  });

  // ── Чтение аналитики ────────────────────────────────────────────────────────────────────────
  // Все суммы наружу — в РУБЛЯХ (внутри и в БД — копейки, канон МойСклада). Кэша нет: агрегаты
  // читаются из своей же БД по индексу, а не из чужого API, и кэш здесь стоил бы только
  // рассогласования сразу после импорта.

  const rub = (v) => (v == null ? null : Number(v) / 100);
  const int = (v) => (v == null ? 0 : Number(v));

  // Что считать выручкой: три прежних режима ИЛИ явный набор статусов `status:complete,delivery`.
  // Разбор и белый список живут в репозитории — он же строит по этому значению SQL-фильтр, и
  // разъехаться двум копиям правила негде.
  const includeOf = (req) => normalizeCdekInclude(req.query.include);

  /** Окно + канал + часовой пояс источника — общий пролог всех читающих роутов. */
  async function resolveRead(req, res) {
    const period = parseCdekPeriod(req.query);
    if (period.invalid) {
      res.status(400).json({ error: 'Некорректный диапазон дат (ожидается from<=to в формате YYYY-MM-DD)' });
      return null;
    }
    const channel = await resolveCdekChannel(req, res);
    if (!channel) return null;
    const source = await db.getCdekSource(channel.id);
    return { channel, period, tz: (source && source.tz) || 'Europe/Moscow', include: includeOf(req) };
  }

  const totalsOf = (row) => (row ? {
    revenue: rub(row.revenue_kopecks),
    orders: int(row.orders),
    items: int(row.items),
    // Средний чек считается ЗДЕСЬ, из тех же двух чисел, что показаны рядом: посчитанный клиентом
    // из округлённых рублей он разошёлся бы с ними на копейки.
    avg_check: int(row.orders) ? rub(row.revenue_kopecks) / int(row.orders) : null,
    orders_all: int(row.orders_all),
    orders_cancelled: int(row.orders_cancelled),
    orders_returned: int(row.orders_returned),
    cancel_share: int(row.orders_all) ? int(row.orders_cancelled) / int(row.orders_all) : null,
  } : null);

  // GET /api/cdek/summary?days=|from=&to=&include= — hero-числа окна и равного предыдущего.
  app.get('/api/cdek/summary', requireAuth, async (req, res, next) => {
    try {
      const ctx = await resolveRead(req, res);
      if (!ctx) return;
      const [totals, bounds] = await Promise.all([
        db.getCdekSummaryForActor(ctx.channel.id, req.user, { ...ctx.period, tz: ctx.tz, include: ctx.include }),
        db.getCdekBoundsForActor(ctx.channel.id, req.user),
      ]);
      res.json({
        window: { days: ctx.period.days, from: ctx.period.from, to: ctx.period.to, all: ctx.period.all },
        // «Всё» сравнивать не с чем — предыдущего окна нет, и выдумывать его нельзя.
        previous_window: ctx.period.all ? null : { from: ctx.period.prevFrom, to: ctx.period.prevTo },
        include: ctx.include,
        current: totalsOf(totals && totals.current),
        previous: ctx.period.all ? null : totalsOf(totals && totals.previous),
        bounds: bounds && bounds.first_day ? bounds : null,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/cdek/series?...&grain=day|week|month — ряд окна и равного предыдущего.
  app.get('/api/cdek/series', requireAuth, async (req, res, next) => {
    try {
      const ctx = await resolveRead(req, res);
      if (!ctx) return;
      const data = await db.getCdekSeriesForActor(ctx.channel.id, req.user, {
        ...ctx.period, tz: ctx.tz, include: ctx.include,
      });
      const point = (r) => ({
        day: r.day, revenue: rub(r.revenue_kopecks), orders: int(r.orders), items: int(r.items),
      });
      res.json({
        window: { days: ctx.period.days, from: ctx.period.from, to: ctx.period.to, all: ctx.period.all },
        grain: data.grain,
        include: ctx.include,
        current: data.current.map(point),
        previous: ctx.period.all ? [] : data.previous.map(point),
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/cdek/breakdown?dim=channel|status|product|carrier&limit= — разрез окна с прошлым окном
  // в тех же строках. Хвост за пределами limit сворачивается в «Прочее» — кольцу и рангу нужен
  // честный знаменатель, а не молча обрезанный список.
  const BREAKDOWN_LIMIT_DEFAULT = 12;
  const BREAKDOWN_LIMIT_MAX = 100;
  app.get('/api/cdek/breakdown', requireAuth, async (req, res, next) => {
    try {
      const ctx = await resolveRead(req, res);
      if (!ctx) return;
      const dim = ['channel', 'status', 'product', 'carrier'].includes(req.query.dim) ? req.query.dim : 'channel';
      // Разбивка ПО статусам обязана видеть все статусы, включая отменённые: отфильтруй мы их
      // «как выручку», она показала бы ровно те статусы, которые сама и отобрала.
      const include = dim === 'status' ? 'all' : ctx.include;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || BREAKDOWN_LIMIT_DEFAULT, 1), BREAKDOWN_LIMIT_MAX);
      const rows = await db.getCdekBreakdownForActor(ctx.channel.id, req.user, {
        ...ctx.period, tz: ctx.tz, include, dim,
      });
      const truncated = rows.length > db.CDEK_BREAKDOWN_MAX_GROUPS;
      const groups = truncated ? rows.slice(0, db.CDEK_BREAKDOWN_MAX_GROUPS) : rows;
      const head = groups.slice(0, limit);
      const tail = groups.slice(limit);
      const fold = (acc, r) => ({
        revenue: acc.revenue + rub(r.revenue_kopecks),
        orders: acc.orders + int(r.orders),
        items: acc.items + int(r.items),
        prev_revenue: acc.prev_revenue + rub(r.prev_revenue_kopecks),
        prev_orders: acc.prev_orders + int(r.prev_orders),
        groups: acc.groups + 1,
      });
      const zero = { revenue: 0, orders: 0, items: 0, prev_revenue: 0, prev_orders: 0, groups: 0 };
      res.json({
        window: { days: ctx.period.days, from: ctx.period.from, to: ctx.period.to, all: ctx.period.all },
        dim,
        include,
        rows: head.map((r) => ({
          // Пустой ключ — это отсутствие значения («Без канала»), а не категория с именем.
          key: r.key === '' ? null : r.key,
          title: r.title || null,
          article: r.article || null,
          sku: r.sku || null,
          revenue: rub(r.revenue_kopecks),
          orders: int(r.orders),
          items: int(r.items),
          prev_revenue: rub(r.prev_revenue_kopecks),
          prev_orders: int(r.prev_orders),
          // Разброс цены за штуку — null, когда строк в окне нет (а не ноль: цены не было).
          price_min: rub(r.price_min_kopecks),
          price_median: rub(r.price_median_kopecks),
          price_max: rub(r.price_max_kopecks),
        })),
        other: tail.length ? tail.reduce(fold, zero) : null,
        total: groups.reduce(fold, zero),
        truncated,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/cdek/hourly — ритм заказов: день недели × час в зоне источника.
  app.get('/api/cdek/hourly', requireAuth, async (req, res, next) => {
    try {
      const ctx = await resolveRead(req, res);
      if (!ctx) return;
      const cells = await db.getCdekHourlyForActor(ctx.channel.id, req.user, {
        ...ctx.period, tz: ctx.tz, include: ctx.include,
      });
      res.json({
        window: { days: ctx.period.days, from: ctx.period.from, to: ctx.period.to, all: ctx.period.all },
        cells: cells.map((c) => ({ weekday: int(c.weekday), hour: int(c.hour), orders: int(c.orders) })),
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/cdek/orders?status=&channel=&q=&limit= — лента заказов окна.
  app.get('/api/cdek/orders', requireAuth, async (req, res, next) => {
    try {
      const ctx = await resolveRead(req, res);
      if (!ctx) return;
      const data = await db.getCdekOrdersForActor(ctx.channel.id, req.user, {
        ...ctx.period,
        tz: ctx.tz,
        include: ctx.include,
        status: req.query.status,
        channel: req.query.channel,
        q: req.query.q,
        limit: req.query.limit,
      });
      res.json({
        window: { days: ctx.period.days, from: ctx.period.from, to: ctx.period.to, all: ctx.period.all },
        total: data.total,
        // Лента ограничена лимитом — честно говорим, что показано не всё, а не молча обрезаем.
        truncated: data.rows.length >= db.CDEK_ORDERS_MAX_ROWS,
        orders: data.rows.map((r) => ({
          order_id: r.order_id,
          created_at: r.created_at,
          status: r.status,
          channel: r.channel,
          carrier: r.carrier,
          external_order_id: r.external_order_id,
          track_number: r.track_number,
          comment: r.comment,
          amount: rub(r.amount_kopecks),
          items: int(r.items),
          positions: int(r.positions),
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/cdek/coverage?from=&to= — выручка по дням рядом с признаком «день залит выгрузкой».
  app.get('/api/cdek/coverage', requireAuth, async (req, res, next) => {
    try {
      const ctx = await resolveRead(req, res);
      if (!ctx) return;
      const bounds = await db.getCdekBoundsForActor(ctx.channel.id, req.user);
      // «Всё» у календаря — это размах архива: без него нечего рисовать, а придумывать окно нельзя.
      const from = ctx.period.from || (bounds && bounds.first_day);
      const to = ctx.period.to || (bounds && bounds.last_day);
      if (!from || !to) return res.json({ from: null, to: null, days: [], bounds: null });
      const days = await db.getCdekCoverageForActor(ctx.channel.id, req.user, {
        from, to, tz: ctx.tz, include: ctx.include,
      });
      res.json({
        from,
        to,
        bounds: bounds && bounds.first_day ? bounds : null,
        truncated: days.length >= db.CDEK_COVERAGE_MAX_DAYS,
        days: days.map((d) => ({
          day: d.day, revenue: rub(d.revenue_kopecks), orders: int(d.orders), covered: d.covered,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  // POST /api/cdek/imports/:id/replay — пересобрать архив из сохранённого файла.
  app.post('/api/cdek/imports/:id/replay', requireAuth, async (req, res, next) => {
    try {
      const channel = await resolveCdekChannel(req, res, { role: 'admin' });
      if (!channel) return;
      const importId = parseInt(req.params.id, 10) || 0;
      const result = await cdekImport.replayImport({ channelId: channel.id, importId });
      await audit(req, 'cdek_import_replay', { channelId: channel.id, importId });
      res.json({ ok: true, import: result.import });
    } catch (e) {
      if (sendImportError(res, e)) return;
      next(e);
    }
  });
}

module.exports = { registerCdekRoutes };
