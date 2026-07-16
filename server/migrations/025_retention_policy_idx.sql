-- Индексы для продуктового ретеншна ingest_receipts и audit_events (см.
-- collectorRepo.pruneIngestReceipts и auditRepo.pruneAuditEvents). Обе таблицы append-only и без
-- age-TTL растут безгранично; ночной bounded-DELETE режет строки старше горизонта батчами в
-- глобальном (не per-channel) порядке. НИКАКИХ удалений данных в самой миграции — только индексы.
--
-- ingest_receipts: предикат `received_at < горизонт`, порядок ORDER BY (received_at, channel_id,
-- ingest_id), удаление по составному PK (channel_id, ingest_id). Существующий
-- ingest_receipts_received_idx(channel_id, received_at DESC) ведёт с channel_id → глобальному
-- ordered-скану по received_at не помогает (каждый батч иначе seq scan + top-N sort по всей
-- растущей таблице). Композит (received_at, channel_id, ingest_id) превращает батч в forward index
-- range scan и сразу отдаёт PK для FOR UPDATE SKIP LOCKED и последующего DELETE. Не частичный:
-- ретеншн здесь чисто возрастной (нет status-предиката), любая строка со временем становится
-- кандидатом — частичность только раздувала бы поддержку без выигрыша.
CREATE INDEX IF NOT EXISTS ingest_receipts_prune_idx
  ON ingest_receipts (received_at, channel_id, ingest_id);

-- audit_events: предикат `created_at < горизонт`, порядок ORDER BY (created_at, id), удаление по
-- стабильному PK id (BIGSERIAL). Существующие (uid|channel_id, created_at DESC) индексы ведут по
-- uid/channel_id и глобальному created_at-скану не помогают. Композит (created_at, id) даёт дешёвый
-- forward range scan + PK-tiebreak для детерминированного батча.
CREATE INDEX IF NOT EXISTS audit_events_prune_idx
  ON audit_events (created_at, id);

-- Forward-only, идемпотентно (IF NOT EXISTS). Обычный (не CONCURRENTLY) CREATE INDEX: раннер
-- миграций оборачивает файл в один BEGIN/COMMIT, а CONCURRENTLY в транзакции недопустим; на одной
-- web-реплике (ADR-002) с текущим объёмом это короткий безопасный build.
