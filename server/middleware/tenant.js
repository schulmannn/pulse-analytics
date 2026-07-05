'use strict';

function makeResolveChannel({ db, isReady }) {
  return async function resolveChannel(req, res, next) {
    if (!db.enabled) {
      req.channel = { id: null, source: 'central', username: '' };
      return next();
    }
    if (!isReady()) return res.status(503).json({ error: 'Сервис запускается, попробуй через секунду' });
    let channelId = parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
    try {
      if (!channelId) {
        const channels = await db.listChannels(req.user);
        if (!channels.length) return res.json({ enabled: true, empty: true, channels: [] });
        channelId = channels[0].id;
      }
      const channel = await db.getChannel(channelId, req.user);
      if (!channel) return res.status(403).json({ error: 'Нет доступа к этому каналу' });
      req.channel = channel;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/* Role gate for WRITE endpoints on a resolved channel (ADR-001). getChannel already attaches the
   caller's effective role (`member_role`: creator → 'owner', else their workspace_members.role, or
   null on legacy rows without a workspace, which only the creator can reach). Rank order:
   viewer < member < admin < owner. Usage AFTER resolveChannel:
     app.post('/api/channels/:id/key', requireAuth, resolveChannel, requireWorkspaceRole('admin'), …) */
const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };

function requireWorkspaceRole(minRole) {
  const need = ROLE_RANK[minRole];
  if (need == null) throw new Error(`unknown workspace role: ${minRole}`);
  return function workspaceRoleGate(req, res, next) {
    // DB off (dev, in-memory mode) → single-user installation, everything allowed.
    if (!req.channel || req.channel.id == null) return next();
    const role = req.channel.member_role || (req.channel.owner_uid === (req.user && req.user.uid) ? 'owner' : null);
    if (role != null && ROLE_RANK[role] >= need) return next();
    return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
  };
}

function makeServeSnapshot({ db }) {
  return async function serveSnapshot(req, res, pick) {
    if (req.channel && req.channel.source === 'central') return false;
    const snapshot = req.channel && req.channel.id
      ? await db.getSnapshot(req.channel.id).catch(() => null)
      : null;
    const value = snapshot && snapshot.data ? pick(snapshot.data, snapshot) : null;
    res.json(value != null ? value : { available: false, source: 'collector', empty: true });
    return true;
  };
}

module.exports = { makeResolveChannel, makeServeSnapshot, requireWorkspaceRole };
