-- 042_ig_backfill_state.sql
-- Состояние догрузки истории Instagram в архив ig_daily (OD-13: «сохранения в базу по аналогии с тг»).
--
-- До этой миграции архив ig_daily начинался с первого дня крона: дневной сбор снимает ровно «вчера»,
-- а исторического бэкфилла не было, поэтому любое окно длиннее архива упиралось в живые 90 дней
-- Graph. Бэкфилл (jobs/igBackfillJob) идёт по дням НАЗАД от вчера-1 и повторяет для каждого дня ТЕ
-- ЖЕ однодневные запросы, что крон, — строка бэкфилла значит ровно то же, что строка крона. Сами
-- данные живут в прежней ig_daily (PK channel_id+day, UTC-день как у крона; OD-8 не трогаем); здесь
-- только операционное состояние прохода: курсор, горизонт, счётчики и дневной бюджет вызовов.
--
-- Таблица ОПЕРАЦИОННАЯ (как ms_backfill_state): в GDPR-экспорт не входит, source_id не несёт (GDPR
-- orphan-sweep не задет), удаляется каскадом вместе с каналом. Смена IG-идентичности канала
-- (переподключили другой аккаунт) сбрасывает состояние по ig_user_id — в коде, не в схеме.
--
-- Forward-only + идемпотентно.

CREATE TABLE IF NOT EXISTS ig_backfill_state (
  channel_id     INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  ig_user_id     TEXT NOT NULL,                  -- чья история; другая идентичность = новый проход
  status         TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','done','error')),
  cursor_day     DATE,                           -- следующий (более старый) день к сбору
  floor_day      DATE,                           -- самый старый день, до которого проход вообще пробует
  horizon_day    DATE,                           -- самый старый день, за который Graph отдал данные
  empty_streak   INTEGER NOT NULL DEFAULT 0,     -- подряд пустых дней (горизонт Graph)
  day_attempts   INTEGER NOT NULL DEFAULT 0,     -- неудачных попыток текущего cursor_day
  days_fetched   INTEGER NOT NULL DEFAULT 0,     -- дней, за которыми сходили в Graph
  days_with_data INTEGER NOT NULL DEFAULT 0,     -- из них вернули данные
  calls_day      DATE,                           -- UTC-день счётчика вызовов
  calls_count    INTEGER NOT NULL DEFAULT 0,     -- вызовов Graph за calls_day (дневной бюджет)
  error          TEXT,                           -- короткий код остановки (ig_reauth, token_decrypt)
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()   -- heartbeat прохода
);

CREATE INDEX IF NOT EXISTS ig_backfill_state_status_idx ON ig_backfill_state (status, updated_at);
