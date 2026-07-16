'use strict';

// Unit-гард на миграцию 025 (индексы продуктового ретеншна). Не PG: читает SQL-файл и проверяет,
// что индексы реально поддерживают предикаты/порядок prune-запросов (collectorRepo.pruneIngestReceipts
// и auditRepo.pruneAuditEvents) — ключи в правильном порядке, идемпотентно, БЕЗ удалений данных.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sqlPath = path.join(__dirname, '..', 'server', 'migrations', '025_retention_policy_idx.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');
const normalized = sql.replace(/\s+/g, ' ');
// Исполняемый SQL без строчных комментариев (в комментариях слово DELETE упоминается пояснительно).
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('025: индекс ingest_receipts по (received_at, channel_id, ingest_id) под ordered prune', () => {
  assert.match(normalized, /CREATE INDEX IF NOT EXISTS ingest_receipts_prune_idx ON ingest_receipts \(received_at, channel_id, ingest_id\)/,
    'композит received_at + составной PK: forward range scan + ключ для FOR UPDATE/DELETE');
});

test('025: индекс audit_events по (created_at, id) под ordered prune', () => {
  assert.match(normalized, /CREATE INDEX IF NOT EXISTS audit_events_prune_idx ON audit_events \(created_at, id\)/,
    'композит created_at + PK id: forward range scan + детерминированный tiebreak');
});

test('025: идемпотентно и без удалений данных в самой миграции', () => {
  assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 2, 'оба индекса — CREATE INDEX IF NOT EXISTS (forward-only, повторяемо)');
  assert.doesNotMatch(code, /\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i, 'миграция только создаёт индексы, ничего не удаляет');
});
