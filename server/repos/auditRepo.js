'use strict';

/* ── Audit trail repo (запись + ретеншн) ─────────────────────────────────────────────────────────
   audit_events — единственный security-журнал (действия с хэшом IP; никогда не хранит пароли,
   ключи, токены). recordAuditEvent — единственный писатель, извлечён ДОСЛОВНО из db.js локального
   набора: публичный db.recordAuditEvent не меняется (mergeExports спредит методы этого repo под
   прежними именами). Ретеншн держится рядом с записью, чтобы горизонт и предикат жили в одном месте.

   Зависит только от pool + enabled (инъекция). */

// Ретеншн audit_events (см. pruneAuditEvents). Продуктовый горизонт — 365 дней по created_at; размер
// одного батча и число батчей за прогон консервативны (≤ 20k строк/прогон — остаток добирают
// следующие прогоны). Прунинг ВЫКЛЮЧЕН по умолчанию: его зовёт maintenance только под явным флагом.
const AUDIT_EVENTS_RETENTION_DAYS_DEFAULT = 365;
const AUDIT_EVENTS_PRUNE_BATCH_DEFAULT = 500;
const AUDIT_EVENTS_PRUNE_MAX_BATCHES_DEFAULT = 40;
const clampInt = (v, def, min, max) =>
  Number.isFinite(+v) ? Math.min(max, Math.max(min, Math.round(+v))) : def;

function createAuditRepo({ pool, enabled }) {
  async function recordAuditEvent({
    uid = null,
    channel_id = null,
    action,
    request_id = null,
    ip_hash = null,
    metadata = {},
  }) {
    if (!enabled || !action) return false;
    await pool.query(
      `INSERT INTO audit_events (uid, channel_id, action, request_id, ip_hash, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        uid,
        channel_id,
        String(action).slice(0, 100),
        request_id,
        ip_hash,
        metadata,
      ],
    );
    return true;
  }

  /* ── Ретеншн: audit_events старше горизонта (по created_at) ────────────────────────────────────
     Модель — pruneTerminalJobs/pruneEmailTokens. audit_events append-only: без прунинга растёт
     безгранично, а продуктовая политика хранит security-журнал 365 дней. Режем строго по возрасту
     (created_at, монотонный DEFAULT now()) — status-предиката нет, любая достаточно старая строка
     кандидат. Маленькие упорядоченные (created_at, id) батчи опираются на audit_events_prune_idx
     (025) → forward index range scan, стабильный план по мере роста. `FOR UPDATE SKIP LOCKED`:
     удаление никогда не ждёт за конкурентным INSERT'ом (вставки не блокируют существующие строки,
     а любую случайно занятую строку доберёт следующий прогон) — прунинг и запись сосуществуют.
     Повторяемо/идемпотентно: capped-остаток добирает следующий прогон. Структурные счётчики
     { deleted, batches, capped }. DB-off → no-op. Клэмпы 1..3650 / 1..10000 / 1..1000. */
  async function pruneAuditEvents({
    maxAgeDays = AUDIT_EVENTS_RETENTION_DAYS_DEFAULT,
    batchSize = AUDIT_EVENTS_PRUNE_BATCH_DEFAULT,
    maxBatches = AUDIT_EVENTS_PRUNE_MAX_BATCHES_DEFAULT,
  } = {}) {
    if (!enabled) return { deleted: 0, batches: 0, capped: false };
    const days = clampInt(maxAgeDays, AUDIT_EVENTS_RETENTION_DAYS_DEFAULT, 1, 3650);
    const limit = clampInt(batchSize, AUDIT_EVENTS_PRUNE_BATCH_DEFAULT, 1, 10000);
    const caps = clampInt(maxBatches, AUDIT_EVENTS_PRUNE_MAX_BATCHES_DEFAULT, 1, 1000);
    let deleted = 0;
    let batches = 0;
    let capped = false;
    for (;;) {
      if (batches >= caps) { capped = true; break; }
      const { rowCount } = await pool.query(
        `DELETE FROM audit_events
          WHERE id IN (
           SELECT id FROM audit_events
            WHERE created_at < now() - make_interval(days => $1)
            ORDER BY created_at, id
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )`,
        [days, limit]);
      batches += 1;
      deleted += rowCount;
      if (rowCount < limit) break;   // хвост исчерпан
    }
    return { deleted, batches, capped };
  }

  return { recordAuditEvent, pruneAuditEvents };
}

module.exports = { createAuditRepo };
