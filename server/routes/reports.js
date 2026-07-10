'use strict';

// ── Именованные отчёты: сохранённые композиции блоков дашборда (+ email-выгрузка) ──
// config — произвольная композиция блоков, целиком принадлежит фронту; сервер
// проверяет только форму (plain object) и размер сериализованного JSON.
const REPORT_CONFIG_MAX_CHARS = 16000;
const REPORT_MAX_BLOCKS = 100;
function reportConfigError(config) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return 'config должен быть объектом';
  // Blocks stay frontend-owned (generic { id, type, config } or legacy string keys); the server
  // only checks the coarse shape so a broken client can't persist garbage: an array of strings or
  // plain objects, capped in count. The 16 KB serialized cap below still bounds everything else.
  if (config.blocks !== undefined) {
    if (!Array.isArray(config.blocks)) return 'config.blocks должен быть массивом';
    if (config.blocks.length > REPORT_MAX_BLOCKS) return `config.blocks: слишком много блоков (макс. ${REPORT_MAX_BLOCKS})`;
    for (const b of config.blocks) {
      const t = typeof b;
      if (t !== 'string' && (t !== 'object' || b === null || Array.isArray(b))) {
        return 'config.blocks: элемент должен быть строкой или объектом';
      }
    }
  }
  if (JSON.stringify(config).length > REPORT_CONFIG_MAX_CHARS) return `config слишком большой (макс. ${REPORT_CONFIG_MAX_CHARS} символов JSON)`;
  return null;
}
const REPORTS_DB_OFF = { error: 'БД не подключена — отчёты недоступны' };

function registerReportsRoutes({ app, db, requireAuth, audit }) {
  app.get('/api/reports', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(REPORTS_DB_OFF);
    try { res.json({ reports: await db.listReports(req.user.uid) }); }
    catch (e) { next(e); }
  });

  app.post('/api/reports', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(REPORTS_DB_OFF);
    const name = String((req.body && req.body.name) || '').trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'name: от 1 до 120 символов' });
    const config = (req.body && req.body.config !== undefined) ? req.body.config : {};
    const bad = reportConfigError(config);
    if (bad) return res.status(400).json({ error: bad });
    try {
      const report = await db.createReport(req.user.uid, name, config);
      audit(req, 'report.created', { report_id: report && report.id }).catch(() => {});
      res.json({ report });
    } catch (e) { next(e); }
  });

  app.get('/api/reports/:id', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(REPORTS_DB_OFF);
    // Full-match digits + a length cap: parseInt would accept '123abc', and anything
    // past 9 digits risks overflowing the int4 id column in Postgres.
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const id = Number(req.params.id);
    try {
      const report = await db.getReport(req.user.uid, id);
      if (!report) return res.status(404).json({ error: 'Отчёт не найден' });
      res.json({ report });
    } catch (e) { next(e); }
  });

  app.put('/api/reports/:id', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(REPORTS_DB_OFF);
    // Full-match digits + a length cap: parseInt would accept '123abc', and anything
    // past 9 digits risks overflowing the int4 id column in Postgres.
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const id = Number(req.params.id);
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name || name.length > 120) return res.status(400).json({ error: 'name: от 1 до 120 символов' });
      patch.name = name;
    }
    if (body.config !== undefined) {
      const bad = reportConfigError(body.config);
      if (bad) return res.status(400).json({ error: bad });
      patch.config = body.config;
    }
    if (body.schedule !== undefined) {
      if (!db.REPORT_SCHEDULES.includes(body.schedule)) return res.status(400).json({ error: 'schedule: none | weekly | monthly' });
      patch.schedule = body.schedule;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Нечего обновлять: нужен name, config или schedule' });
    try {
      const report = await db.updateReport(req.user.uid, id, patch);
      if (!report) return res.status(404).json({ error: 'Отчёт не найден' });
      audit(req, 'report.updated', { report_id: id, fields: Object.keys(patch) }).catch(() => {});
      res.json({ report });
    } catch (e) { next(e); }
  });

  app.delete('/api/reports/:id', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(REPORTS_DB_OFF);
    // Full-match digits + a length cap: parseInt would accept '123abc', and anything
    // past 9 digits risks overflowing the int4 id column in Postgres.
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const id = Number(req.params.id);
    try {
      const ok = await db.deleteReport(req.user.uid, id);
      if (!ok) return res.status(404).json({ error: 'Отчёт не найден' });
      audit(req, 'report.deleted', { report_id: id }).catch(() => {});
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}

module.exports = { registerReportsRoutes };
