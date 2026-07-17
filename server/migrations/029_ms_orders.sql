-- ── МойСклад: архив заказов покупателей + состояние чанкового бэкфилла ────────
-- ms_orders — по строке на заказ (customerorder) канала; наполняется движком бэкфилла
-- (jobs/msBackfillJob) помесячными страницами и дневной доливкой. Upsert по
-- (channel_id, order_id) ЗАМЕНЯЕТ строку целиком: заказы в МС правят задним числом
-- (сумма/статус/контрагент), повторный проход честно доносит правки, не COALESCE'ит.
-- Суммы — в КОПЕЙКАХ (BIGINT, как ms_daily); в рубли конвертирует только граница API.
-- ON DELETE CASCADE — архив живёт и умирает вместе с каналом (отключение ms_accounts его
-- НЕ трогает — история остаётся, повторный connect продолжит).
CREATE TABLE IF NOT EXISTS ms_orders (
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  order_id    TEXT NOT NULL,                    -- id заказа у МС (UUID)
  moment      TIMESTAMPTZ NOT NULL,             -- дата/время заказа (moment)
  sum_kopecks BIGINT NOT NULL DEFAULT 0,        -- сумма заказа, копейки
  state       TEXT,                             -- имя статуса (если МС его прислал)
  agent_id    TEXT,                             -- id контрагента (последний сегмент meta.href)
  agent_name  TEXT,                             -- имя контрагента (если МС его прислал)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, order_id)
);
-- Оконные чтения архива (period-срезы, будущие отчёты) идут по каналу+дате.
CREATE INDEX IF NOT EXISTS ms_orders_channel_moment_idx ON ms_orders (channel_id, moment);

-- Durable-состояние бэкфилла — по строке на канал. cursor_from — начало ЕЩЁ НЕ добранного
-- окна (движок продвигает его помесячно), поэтому рестарт процесса продолжает с места, а не
-- с нуля. updated_at обновляется на КАЖДОЙ странице — свежесть строки отличает живой прогон
-- (single-flight отказ) от брошенного (resume в recovery-бегунке). error хранит краткое
-- сообщение последнего фатального сбоя (без токенов — их нет в ошибках по построению msClient).
CREATE TABLE IF NOT EXISTS ms_backfill_state (
  channel_id     INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','done','error')),
  cursor_from    DATE,                          -- начало недобранного окна (NULL до первого старта)
  total_estimate INTEGER,                       -- meta.size на момент старта (оценка, не инвариант)
  fetched_count  INTEGER NOT NULL DEFAULT 0,    -- страниц-нарастающий счётчик принятых заказов
  error          TEXT,
  started_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
