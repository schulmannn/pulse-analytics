'use strict';

const crypto = require('crypto');
const { log } = require('../lib/observability');
const {
  CURRENT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  ContractError,
  normalizeEnvelope,
  prepareStorage,
} = require('../collector/contract');

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function createCollectorHandler({ db, audit }) {
  return async function collectorHandler(req, res) {
    try {
      const normalized = normalizeEnvelope(req.body);
      const storage = prepareStorage(normalized, db.graphsToDailyRows);
      const payloadHash = sha256(JSON.stringify(normalized));
      const result = await db.ingestCollectorPayload(req.channel.id, {
        ingest_id: normalized.ingest_id,
        schema_version: normalized.schema_version,
        collector_version: normalized.collector_version,
        collected_at: normalized.collected_at,
        payload_hash: payloadHash,
      }, storage);
      if (audit) audit(req, 'collector.ingest', {
        ingest_id: normalized.ingest_id,
        duplicate: !!result.duplicate,
        legacy: normalized.legacy,
      }).catch(() => {});
      res.status(result.duplicate ? 200 : 202).json({
        ...result,
        warnings: normalized.legacy
          ? ['Legacy payload accepted; send schema_version, ingest_id, collector_version and collected_at.']
          : [],
      });
    } catch (error) {
      if (error instanceof ContractError) {
        return res.status(400).json({
          error: error.message,
          code: error.code,
          details: error.details,
          supported_schema_versions: SUPPORTED_SCHEMA_VERSIONS,
        });
      }
      if (error.code === 'INGEST_ID_CONFLICT') {
        return res.status(409).json({ error: error.message, code: error.code });
      }
      // unknown = internal (db/driver): log the real error, answer generic — collectors
      // must not see internals, and their queue retries on any 5xx anyway.
      log('error', 'collector_ingest_failed', {
        request_id: req.requestId,
        channel_id: req.channel && req.channel.id,
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: 'internal_error', request_id: req.requestId });
    }
  };
}

function registerCollectorRoutes({
  app, db, express, rateLimit, isReady, requireAuth, audit,
}) {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    keyGenerator: req => {
      const header = String(req.get('authorization') || '');
      const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.get('x-api-key') || '').trim();
      return raw ? sha256(raw) : `ip:${req.ip || ''}`;
    },
    message: { error: 'Слишком много ingest-запросов' },
  });

  async function requireApiKey(req, res, next) {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
    if (!isReady()) return res.status(503).json({ error: 'Сервис запускается' });
    const header = String(req.get('authorization') || '');
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.get('x-api-key') || '').trim();
    if (!raw) return res.status(401).json({ error: 'Нет API-ключа' });
    try {
      const channel = await db.getChannelByApiKey(sha256(raw));
      if (!channel || channel.status === 'disabled' || channel.source === 'central') {
        return res.status(401).json({ error: 'Неверный или отозванный ключ' });
      }
      req.channel = channel;
      next();
    } catch (error) {
      next(error);
    }
  }

  app.get('/api/collector/compatibility', requireApiKey, (req, res) => {
    res.json({
      current_schema_version: CURRENT_SCHEMA_VERSION,
      supported_schema_versions: SUPPORTED_SCHEMA_VERSIONS,
      max_payload_bytes: 4 * 1024 * 1024,
      server_time: new Date().toISOString(),
      channel_id: req.channel.id,
    });
  });
  app.post(
    '/api/collector/ingest',
    limiter,
    requireApiKey,
    express.json({ limit: '4mb' }),
    createCollectorHandler({ db, audit }),
  );
  app.get('/api/channels/:id/collector-status', requireAuth, async (req, res, next) => {
    const channelId = parseInt(req.params.id, 10);
    if (!channelId) return res.status(400).json({ error: 'bad id' });
    try {
      const channel = await db.getChannel(channelId, req.user);
      if (!channel) return res.status(403).json({ error: 'Нет доступа к каналу' });
      const status = await db.getCollectorStatus(channelId, req.user);
      const staleAfterHours = Math.max(1, parseInt(process.env.COLLECTOR_STALE_HOURS, 10) || 24);
      const lastSuccessMs = status && status.last_success_at
        ? new Date(status.last_success_at).getTime()
        : 0;
      const stale = !lastSuccessMs || Date.now() - lastSuccessMs > staleAfterHours * 60 * 60 * 1000;
      res.json({ status: status ? { ...status, stale, stale_after_hours: staleAfterHours } : null });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { createCollectorHandler, registerCollectorRoutes };
