'use strict';

const { hasWorkspaceRole } = require('../middleware/tenant');

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
      const filename = String(req.headers['x-filename'] || 'выгрузка.xlsx').slice(0, 200);

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
