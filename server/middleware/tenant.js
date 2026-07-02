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

module.exports = { makeResolveChannel, makeServeSnapshot };
