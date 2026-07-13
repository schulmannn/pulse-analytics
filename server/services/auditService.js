// ═══════════════════════════════════════════════════════════════
//  Atlavue — audit service (журнал действий с хэшом IP)
// ═══════════════════════════════════════════════════════════════
// Фабрика audit-домена (декомпозиция index.js, PR C): audit(req, action, metadata) —
// единственный писатель audit_events. Без чтения окружения/Express; тело перенесено из
// index.js literal (поведение-preserving).

'use strict';

const crypto = require('crypto');
const { hashIp } = require('../lib/observability');

function createAuditService({ db, authSecret }) {
  // Domain-separated subkey derived from AUTH_SECRET — the raw session-signing
  // secret is never reused directly for other HMAC purposes.
  // (The OAuth-state signing subkey ('ig-state') is derived in routes/ig-oauth.js from the injected
  // AUTH_SECRET, alongside the sign/parse helpers that are its only consumers.)
  const IP_HASH_KEY = crypto.createHmac('sha256', authSecret).update('ip-hash').digest();

  async function audit(req, action, metadata = {}) {
    if (!db.enabled) return false;
    return db.recordAuditEvent({
      uid: req.user && req.user.uid != null ? req.user.uid : null,
      channel_id: req.channel && req.channel.id != null ? req.channel.id : null,
      action,
      request_id: req.requestId,
      ip_hash: hashIp(req.ip, IP_HASH_KEY),
      metadata,
    });
  }

  return { audit };
}

module.exports = { createAuditService };
