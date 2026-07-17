-- ── МойСклад: дневной архив продаж/заказов — per-channel ─────────────────────
-- Дневная строка на (channel, day), пишется кроном (jobs/msCollectionJob) с 7-дневным
-- перекрытием: отчёты МС правятся задним числом (документы редактируют/удаляют), поэтому
-- повторный проход ПЕРЕЗАПИСЫВАЕТ окно целиком — идемпотентный upsert, не дозапись.
-- Все суммы — в КОПЕЙКАХ (BIGINT, точность: никакой float-арифметики в БД); в рубли
-- конвертирует только граница API (kopecksToRub в routes/moysklad.js). ON DELETE CASCADE —
-- архив живёт и умирает вместе с каналом (как ig_daily), удаление ms_accounts его НЕ трогает.
CREATE TABLE IF NOT EXISTS ms_daily (
  channel_id         INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  day                DATE NOT NULL,
  revenue_kopecks    BIGINT NOT NULL DEFAULT 0,   -- выручка (report/sales) за день, копейки
  orders_count       INTEGER NOT NULL DEFAULT 0,  -- количество заказов (report/orders) за день
  orders_sum_kopecks BIGINT NOT NULL DEFAULT 0,   -- сумма заказов (report/orders) за день, копейки
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, day)
);
