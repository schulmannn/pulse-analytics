-- ── История Instagram + сырые снапшоты (accumulate-now) ──────────────────────
-- IG отдаёт только короткое окно (сторис живут 24ч, серия follower_count ~30д,
-- у демографии истории НЕТ вовсе), поэтому мы начинаем складывать всё в Postgres
-- СЕЙЧАС, чтобы накопить историю для будущих графиков. Три таблицы:
--   ig_daily        — дневные метрики IG-аккаунта (одна строка на канал+день);
--   ig_media_daily  — накопительная траектория lifetime-инсайтов по каждому посту
--                     (строка на канал+медиа+день → видно, как цифры росли);
--   raw_snapshots   — сырые payload'ы «как есть» (TG /graphs, IG demographics/
--                     online/stories) для того, что не ложится в дневную сетку.
-- Все FK ссылаются на channels(id) INTEGER (тот же таргет, что ig_accounts, 003),
-- НЕ на bigint tg_channel_id. ON DELETE CASCADE — чистится вместе с каналом.
-- Идемпотентно per the migration runner (IF NOT EXISTS), стиль 006/007.

-- Дневные метрики аккаунта. Только то, что реально возвращает Instagram-Login API
-- (graph.instagram.com): reach/follower_count — дневные серии; остальное —
-- window-агрегаты total_value, кладём как снимок дня. Все счётчики nullable:
-- отсутствующая/неподдерживаемая метрика остаётся NULL, а не 0.
CREATE TABLE IF NOT EXISTS ig_daily (
  channel_id         INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  day                DATE    NOT NULL,
  followers          INTEGER,   -- follower_count (дневной прирост нетто)
  reach              INTEGER,
  views              INTEGER,
  profile_views      INTEGER,
  accounts_engaged   INTEGER,
  total_interactions INTEGER,
  likes              INTEGER,
  comments           INTEGER,
  saves              INTEGER,
  shares             INTEGER,
  follows            INTEGER,   -- follows_and_unfollows → FOLLOWER
  unfollows          INTEGER,   -- follows_and_unfollows → NON_FOLLOWER
  captured_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, day)
);
CREATE INDEX IF NOT EXISTS ig_daily_chan_idx ON ig_daily(channel_id);

-- Per-media lifetime-инсайты, снятые по дням. Insights по конкретному медиа —
-- CUMULATIVE (растут от публикации), поэтому одна строка на (channel, media, day)
-- фиксирует траекторию день-за-днём (живой роут показывает только текущее значение).
CREATE TABLE IF NOT EXISTS ig_media_daily (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  media_id   TEXT    NOT NULL,
  day        DATE    NOT NULL,
  reach      INTEGER,
  likes      INTEGER,
  comments   INTEGER,
  saved      INTEGER,
  shares     INTEGER,
  views      INTEGER,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, media_id, day)
);
CREATE INDEX IF NOT EXISTS ig_media_daily_chan_idx ON ig_media_daily(channel_id);

-- Сырой catch-all: полный payload источника «как есть» под ключом (канал,источник,
-- вид,день). PK гарантирует, что повторный прогон за тот же день перезаписывает
-- (upsert), а не плодит дубли. created_at индексируется для ретеншн-прунинга.
-- source: 'tg' | 'ig'; kind: 'graphs' | 'demographics' | 'online' | 'stories' | …
CREATE TABLE IF NOT EXISTS raw_snapshots (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  source     TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  day        DATE    NOT NULL,
  payload    JSONB   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, source, kind, day)
);
CREATE INDEX IF NOT EXISTS raw_snapshots_created_idx ON raw_snapshots(created_at);
