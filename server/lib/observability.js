'use strict';

const crypto = require('crypto');

function log(level, event, fields = {}) {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function requestContext(req, res, next) {
  const incoming = String(req.get('x-request-id') || '').trim();
  req.requestId = /^[A-Za-z0-9._:-]{8,100}$/.test(incoming)
    ? incoming
    : crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.path.startsWith('/api/') && res.statusCode < 500) return;
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    log(res.statusCode >= 500 ? 'error' : 'info', 'http_request', {
      request_id: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 10) / 10,
      uid: req.user && req.user.uid != null ? req.user.uid : undefined,
      channel_id: req.channel && req.channel.id != null ? req.channel.id : undefined,
    });
  });
  next();
}

function hashIp(ip, secret) {
  if (!ip) return null;
  return crypto.createHmac('sha256', secret).update(String(ip)).digest('hex').slice(0, 24);
}

module.exports = { log, requestContext, hashIp };
