-- ── Яндекс.Метрика: дневная история КАЧЕСТВА трафика + маркер бэкфилла (слайс качества) ──────
-- 033 копит только визиты/посетители/просмотры. Здесь расширяем ym_daily nullable-полями
-- качества (отказы, средняя длительность визита, глубина, новые посетители и их доля) плюс
-- ЯВНЫЙ сигнал роботности (robot_visits/robot_percentage): роботы «по поведению» Метрика
-- включает в трафик по умолчанию и они искажают отказы/длительность/глубину, поэтому мы их не
-- прячем и не вычитаем молча, а показываем отдельной величиной.
--   • Счётчики (new_users, robot_visits) — BIGINT (канон 023: крупные сайты в INTEGER не обязаны
--     влезать). Доли/средние — DOUBLE PRECISION (проценты и секунды с дробной частью).
--   • ВСЕ новые поля nullable и БЕЗ DEFAULT: «нет данных» (день без трафика, нулевой знаменатель
--     доли/средней) обязан остаться NULL, а не стать ложным нулём — тот же честный контракт, что
--     у живых summary-роутов. Счётчики за день без трафика крон пишет честным 0, доли — NULL.
--   • Идемпотентно (ADD COLUMN IF NOT EXISTS) — forward-only миграция применяется на старте.
ALTER TABLE ym_daily ADD COLUMN IF NOT EXISTS bounce_rate                DOUBLE PRECISION;
ALTER TABLE ym_daily ADD COLUMN IF NOT EXISTS avg_visit_duration_seconds DOUBLE PRECISION;
ALTER TABLE ym_daily ADD COLUMN IF NOT EXISTS page_depth                 DOUBLE PRECISION;
ALTER TABLE ym_daily ADD COLUMN IF NOT EXISTS new_users                  BIGINT;
ALTER TABLE ym_daily ADD COLUMN IF NOT EXISTS percent_new_visitors       DOUBLE PRECISION;
ALTER TABLE ym_daily ADD COLUMN IF NOT EXISTS robot_visits               BIGINT;
ALTER TABLE ym_daily ADD COLUMN IF NOT EXISTS robot_percentage           DOUBLE PRECISION;

-- Durable per-account маркер одноразового бэкфилла качества. Слайсы 1–3 уже наполнили ym_daily
-- визитами/посетителями/просмотрами БЕЗ полей качества; этот маркер даёт таким непустым архивам
-- ровно ОДИН полный историко-качественный бэкфилл. NULL = история качества ещё не докачана
-- целиком; ставится ТОЛЬКО после успешного НЕПУСТОГО upsert'а полного бэкфилла
-- (jobs/ymCollectionJob), guarded channel+counter — переподключение ДРУГОГО счётчика тем же
-- каналом не наследует чужой маркер. Идемпотентно (ADD COLUMN IF NOT EXISTS).
ALTER TABLE ym_accounts ADD COLUMN IF NOT EXISTS quality_backfilled_at TIMESTAMPTZ;
