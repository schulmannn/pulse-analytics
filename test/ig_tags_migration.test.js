'use strict';

// Unit-гард на миграцию 026 (tenant-scope ig_tags). Не PG: читает SQL-файл и проверяет, что архив
// тегов становится per-channel (channel_id/source_id, scoped uniqueness), НЕ теряя старые строки:
// forward-only, идемпотентно, без удаления данных (legacy строки кварантинятся, а не стираются).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sqlPath = path.join(__dirname, '..', 'server', 'migrations', '026_ig_tags_channel_scope.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');
const normalized = sql.replace(/\s+/g, ' ');
// Исполняемый SQL без строчных комментариев (в комментариях DELETE/quarantine упоминаются пояснительно).
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('026: channel_id — nullable FK на channels с ON DELETE CASCADE (tenant scope)', () => {
  assert.match(normalized,
    /ALTER TABLE ig_tags ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels\(id\) ON DELETE CASCADE/,
    'channel_id стамп тенанта, каскад с каналом');
});

test('026: source_id — FK на external_sources (parity с ig_daily)', () => {
  assert.match(normalized,
    /ALTER TABLE ig_tags ADD COLUMN IF NOT EXISTS source_id\s+INTEGER REFERENCES external_sources\(id\)/,
    'canonical ig-source parity');
});

test('026: старый single-column PK(media_id) снят — общий media_id живёт в разных scope', () => {
  assert.match(normalized, /ALTER TABLE ig_tags DROP CONSTRAINT IF EXISTS ig_tags_pkey/,
    'без media_id-PK одинаковый media_id может существовать под разными channel-scope');
});

test('026: scoped uniqueness / upsert-таргет (channel_id, media_id)', () => {
  assert.match(normalized,
    /CREATE UNIQUE INDEX IF NOT EXISTS ig_tags_channel_media_idx ON ig_tags \(channel_id, media_id\)/,
    'одна строка на (channel, media) — conflict target для scoped upsert; legacy NULL-scope distinct');
});

test('026: channel-scoped read index (channel_id, posted_at DESC)', () => {
  assert.match(normalized,
    /CREATE INDEX IF NOT EXISTS ig_tags_channel_posted_idx ON ig_tags \(channel_id, posted_at DESC NULLS LAST\)/,
    'newest-first внутри одного channel-scope');
});

test('026: forward-only/идемпотентно и БЕЗ удаления строк (legacy кварантин, не стирание)', () => {
  assert.match(normalized, /ADD COLUMN IF NOT EXISTS/, 'колонки — IF NOT EXISTS');
  assert.match(normalized, /DROP CONSTRAINT IF EXISTS/, 'снятие PK — IF EXISTS');
  assert.match(normalized, /CREATE UNIQUE INDEX IF NOT EXISTS/, 'уникальный индекс — IF NOT EXISTS');
  // Схемные DROP CONSTRAINT/DROP INDEX и ON DELETE CASCADE допустимы; удаление ДАННЫХ (строк) — нет.
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+TABLE\b/i,
    'миграция не удаляет строки — старые данные сохраняются (карантин через NULL channel_id)');
});
