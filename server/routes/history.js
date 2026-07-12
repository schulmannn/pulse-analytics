'use strict';

/**
 * Postgres-backed history reads — the archive that outlives Telegram's ~3-month live window.
 * Extracted verbatim from index.js. Both routes are tenant-scoped: resolveChannel enforces
 * ownership and sets req.channel before the handler runs. DB-less / error paths degrade to an
 * empty (but shaped) 200 so the dashboard never hard-fails on the history panels.
 */
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
      const data = await db.getMentionsArchiveForActor(req.channel.id, req.user, 30);
      res.json({ enabled: db.enabled, ...(data || { available: false }) });
    } catch (e) {
      res.status(200).json({ enabled: db.enabled, available: false, error: e.message });
    }
  });
}

module.exports = { registerHistoryRoutes };
