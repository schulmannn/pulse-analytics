'use strict';

const crypto = require('crypto');
const { hasWorkspaceRole } = require('../middleware/tenant');

// Raw collector key → stored hash. The raw key is shown ONCE and never persisted (see POST .../key).
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * Channels (tenants) the user owns: CRUD, collector API keys, and timeline annotations. Extracted
 * verbatim from index.js — every write still passes an ownership check (db.getChannel +
 * hasWorkspaceRole) per ADR-001, and the central/no-DB fallback is unchanged.
 *
 * `getDbReady` is a thunk (not a value) on purpose: dbReady is the live migration-gate flag in
 * index.js that flips true after db.init() — it must be read per-request, not captured once.
 */
function registerChannelsRoutes({ app, db, requireAuth, audit, getDbReady }) {
  // Channels (tenants) the user owns — drives the dashboard channel switcher.
  // No DB → one synthetic 'central' channel (id 0) so the legacy single-channel
  // dashboard still works locally without Postgres.
  app.get('/api/channels', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.json({ enabled: false, channels: [{ id: 0, username: '', title: '', source: 'central' }], selected: 0 });
    if (!getDbReady()) return res.status(503).json({ error: 'Сервис запускается' });
    try {
      const channels = await db.listChannels(req.user);
      res.json({ enabled: true, channels, selected: channels[0] ? channels[0].id : null });
    } catch (e) { next(e); }
  });

  // Create a channel (self-serve).
  app.post('/api/channels', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
    const username = String((req.body && req.body.username) || '').replace(/^@/, '').trim();
    const title = String((req.body && req.body.title) || '').trim().slice(0, 120);
    if (!/^[a-zA-Z0-9_]{3,64}$/.test(username)) return res.status(400).json({ error: 'Некорректный @username канала' });
    try {
      const mine = await db.listChannels(req.user);
        if (mine.length >= 20) return res.status(409).json({ error: 'Достигнут лимит каналов' });   // soft cap; tiers in Sprint 2
        const channel = await db.createChannel({ owner_uid: req.user.uid, username, title });
        req.channel = channel;
        audit(req, 'channel.created', { username }).catch(() => {});
        res.json(channel);
    } catch (e) { next(e); }
  });

  app.delete('/api/channels/:id', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const ok = await db.deleteChannel(id, req.user.uid);
      if (ok) audit(req, 'channel.deleted', { channel_id: id }).catch(() => {});
      res.json({ ok });
    }
    catch (e) { next(e); }
  });

  // Generate an API key for a channel the user owns — the raw key is shown ONCE.
  app.post('/api/channels/:id/key', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const ch = await db.getChannel(id, req.user);
      if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
      // A collector key is a standing data-write credential — workspace admins only (ADR-001).
      if (!hasWorkspaceRole(ch, req.user, 'admin')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      if (ch.source === 'central') return res.status(400).json({ error: 'central-канал не использует collector-ключи' });
        const raw = 'pa_' + crypto.randomBytes(24).toString('base64url');
        const rec = await db.createApiKey(id, sha256(raw), raw.slice(0, 11), String((req.body && req.body.label) || '').slice(0, 60) || null);
        req.channel = ch;
        audit(req, 'api_key.created', { key_id: rec.id, key_prefix: rec.key_prefix }).catch(() => {});
        res.json({ ...rec, key: raw });   // raw key — never stored, shown once
    } catch (e) { next(e); }
  });

  app.get('/api/channels/:id/keys', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.json({ keys: [] });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const ch = await db.getChannel(id, req.user);
      if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
      if (!hasWorkspaceRole(ch, req.user, 'admin')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      res.json({ keys: await db.listApiKeys(id, req.user.uid) });
    }
    catch (e) { next(e); }
  });

  app.delete('/api/channels/:id/key/:keyId', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
    const id = parseInt(req.params.id, 10);
    const keyId = parseInt(req.params.keyId, 10);
    if (!id || !keyId) return res.status(400).json({ error: 'bad id' });
    try {
      const ch = await db.getChannel(id, req.user);
      if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
      if (!hasWorkspaceRole(ch, req.user, 'admin')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      const ok = await db.revokeApiKey(keyId, id, req.user.uid);
      if (ok) audit(req, 'api_key.revoked', { key_id: keyId }).catch(() => {});
      res.json({ ok });
    }
    catch (e) { next(e); }
  });

  // ── Timeline annotations (F1): per-channel event markers on the trend charts ──
  app.get('/api/channels/:id/annotations', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.json({ annotations: [] });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const ch = await db.getChannel(id, req.user);
      if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
      res.json({ annotations: await db.listAnnotations(id) });
    } catch (e) { next(e); }
  });

  app.post('/api/channels/:id/annotations', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
    const id = parseInt(req.params.id, 10);
    const day = String((req.body && req.body.day) || '').trim();
    const label = String((req.body && req.body.label) || '').trim();
    if (!id) return res.status(400).json({ error: 'bad id' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'day = YYYY-MM-DD' });
    if (!label) return res.status(400).json({ error: 'label обязателен' });
    try {
      const ch = await db.getChannel(id, req.user);
      if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
      if (!hasWorkspaceRole(ch, req.user, 'member')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      const rec = await db.createAnnotation(id, { day, label: label.slice(0, 120), createdBy: req.user.uid });
      audit(req, 'annotation.created', { channel_id: id, annotation_id: rec && rec.id }).catch(() => {});
      res.json(rec);
    } catch (e) { next(e); }
  });

  app.delete('/api/channels/:id/annotations/:annId', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
    const id = parseInt(req.params.id, 10);
    const annId = parseInt(req.params.annId, 10);
    if (!id || !annId) return res.status(400).json({ error: 'bad id' });
    try {
      const ch = await db.getChannel(id, req.user);
      if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
      if (!hasWorkspaceRole(ch, req.user, 'member')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      const ok = await db.deleteAnnotation(annId, id);
      if (ok) audit(req, 'annotation.deleted', { channel_id: id, annotation_id: annId }).catch(() => {});
      res.json({ ok });
    } catch (e) { next(e); }
  });
}

module.exports = { registerChannelsRoutes };
