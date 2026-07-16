'use strict';

function makeResolveChannel({ db, isReady }) {
  return async function resolveChannel(req, res, next) {
    if (!db.enabled) {
      req.channel = { id: null, source: 'central', username: '' };
      return next();
    }
    if (!isReady()) return res.status(503).json({ error: 'Сервис запускается, попробуй через секунду' });
    const channelId = parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
    try {
      // Auth/tenant hot path: resolve the request's channel in ONE query. getChannelOrDefault picks
      // the caller's default channel (same visibility + created_at order as listChannels, with the
      // effective member_role) when no id is given, or enforces getChannel's ownership/disabled/role
      // semantics for an explicit id — folding the old getDefaultChannelId + getChannel pair into a
      // single round-trip on the default path. The explicit-vs-default response split stays here: the
      // repo returns null in both no-row cases, and only the middleware knows the id was explicit.
      const explicit = channelId !== 0;
      const channel = await db.getChannelOrDefault(channelId, req.user);
      if (!channel) {
        if (explicit) return res.status(403).json({ error: 'Нет доступа к этому каналу' });
        return res.json({ enabled: true, empty: true, channels: [] });
      }
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

/** Pure check for routes that fetch the channel themselves (db.getChannel attaches member_role;
 *  legacy rows without a workspace are creator-only, which the fallback covers). */
function hasWorkspaceRole(channel, user, minRole) {
  const need = ROLE_RANK[minRole];
  if (need == null) throw new Error(`unknown workspace role: ${minRole}`);
  if (!channel || channel.id == null) return true; // DB off (dev in-memory) → single-user mode
  const role = channel.member_role || (channel.owner_uid === (user && user.uid) ? 'owner' : null);
  return role != null && ROLE_RANK[role] >= need;
}

function requireWorkspaceRole(minRole) {
  // validate eagerly so a typo fails at boot, not on first request
  if (ROLE_RANK[minRole] == null) throw new Error(`unknown workspace role: ${minRole}`);
  return function workspaceRoleGate(req, res, next) {
    if (hasWorkspaceRole(req.channel, req.user, minRole)) return next();
    return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
  };
}

function makeServeSnapshot({ db }) {
  return async function serveSnapshot(req, res, pick) {
    const isCentral = req.channel && req.channel.source === 'central';
    // Internal: req.channel уже resolved вызывающим роутом (resolveChannel сделал ownership-check).
    const snapshot = req.channel && req.channel.id
      ? await db.getSnapshotInternal(req.channel.id).catch(() => null)
      : null;
    const value = snapshot && snapshot.data ? pick(snapshot.data, snapshot) : null;
    // Managed central: the daily ingest now persists a snapshot for the central channel through the
    // owner's session, so serve it exactly like a managed-QR channel WHEN present. When absent (no
    // managed collection yet), return false so the caller keeps its old live global MTProto behavior.
    if (isCentral) {
      if (value == null) return false;
      res.json(value);
      return true;
    }
    res.json(value != null ? value : { available: false, source: 'collector', empty: true });
    return true;
  };
}

module.exports = { makeResolveChannel, makeServeSnapshot, requireWorkspaceRole, hasWorkspaceRole };
