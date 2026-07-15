'use strict';

/**
 * Postgres-backed history reads — the archive that outlives Telegram's ~3-month live window.
 * Extracted verbatim from index.js. Both routes are tenant-scoped: resolveChannel enforces
 * ownership and sets req.channel before the handler runs. DB-less / error paths degrade to an
 * empty (but shaped) 200 so the dashboard never hard-fails on the history panels.
 */
const { parseMentionsRange } = require('../lib/mentionsRange');

function registerHistoryRoutes({ app, requireAuth, resolveChannel, db }) {
  app.get('/api/history/channel', requireAuth, resolveChannel, async (req, res) => {
    const days = Math.min(1000, parseInt(req.query.days) || 365);
    try {
      res.json({ enabled: db.enabled, rows: await db.getChannelHistoryForActor(req.channel.id, req.user, days) });
    } catch (e) {
      res.status(200).json({ enabled: db.enabled, rows: [], error: e.message });
    }
  });

  app.get('/api/history/mentions', requireAuth, resolveChannel, async (req, res) => {
    try {
      // Legacy/mobile/Home передают только limit → days=0 (весь архив). Desktop передаёт выбранный
      // период (7/30/90) ЛИБО свой диапазон (from/to, включительно) + optional source (упомянувший
      // channel_id) + limit (clamp 1..100 в репо). Валидный range приоритетнее days-пресета.
      const daysText = String(req.query.days ?? '');
      const days = daysText === '7' || daysText === '30' || daysText === '90' ? Number(daysText) : 0;
      const limitText = String(req.query.limit ?? '');
      const limitRaw = /^\d+$/.test(limitText) ? Number(limitText) : Number.NaN;
      const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 30;
      const rangeRequested = req.query.from !== undefined || req.query.to !== undefined;
      const range = parseMentionsRange(req.query);
      if (rangeRequested && !range) {
        return res.status(400).json({ error: 'from и to должны быть корректными датами YYYY-MM-DD, from не позже to' });
      }
      const data = await db.getMentionsArchiveForActor(req.channel.id, req.user, {
        days, limit, source: req.query.source, range,
      });
      res.json({ enabled: db.enabled, ...(data || { available: false }) });
    } catch (e) {
      res.status(200).json({ enabled: db.enabled, available: false, error: e.message });
    }
  });
}

module.exports = { registerHistoryRoutes };
