-- ── Яндекс.Метрика (Reporting API) — per-channel ─────────────────────────────
-- Одна учётка Метрики (счётчик) на канал/тенант, зеркально ms_accounts (026): OAuth-токен
-- хранится ТОЛЬКО шифрованным (AES-256-GCM через YM_TOKEN_KEY) — никогда в plaintext.
-- counter_id — id счётчика из management/v1/counters (стабильная идентичность, по ней
-- дедупятся повторные connect), counter_name/site — витринные подписи источника,
-- counter_created_day — дата создания счётчика (якорь окна «Всё» и бэкфилла архива).
CREATE TABLE IF NOT EXISTS ym_accounts (
  channel_id          INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  counter_id          TEXT NOT NULL,
  counter_name        TEXT,
  site                TEXT,
  counter_created_day DATE,
  access_token_enc    TEXT NOT NULL,           -- AES-256-GCM, формат: ivHex:tagHex:cipherHex
  source_id           INTEGER REFERENCES external_sources(id),
  connected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Дневной архив визитов/посетителей/просмотров — per-channel, зеркально ms_daily (027).
-- Пишется кроном (jobs/ymCollectionJob): первый проход после connect бэкфиллит всю историю
-- счётчика одним отчётом, дальше — окно с 7-дневным перекрытием: Метрика допересчитывает
-- свежие дни (дорезка сессий, пересмотр роботности), поэтому повторный проход ПЕРЕЗАПИСЫВАЕТ
-- окно целиком — идемпотентный upsert, не дозапись. Счётчики BIGINT (канон 023): визиты
-- больших сайтов в INTEGER не обязаны влезать. ON DELETE CASCADE — архив живёт и умирает
-- вместе с каналом (как ms_daily), удаление ym_accounts его НЕ трогает.
CREATE TABLE IF NOT EXISTS ym_daily (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  visits     BIGINT NOT NULL DEFAULT 0,   -- визиты (ym:s:visits) за день
  users      BIGINT NOT NULL DEFAULT 0,   -- посетители (ym:s:users) за день
  pageviews  BIGINT NOT NULL DEFAULT 0,   -- просмотры страниц (ym:s:pageviews) за день
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, day)
);

-- Расширение CHECK external_sources.network до 'ym' — тот же гейтованный DO-блок, что в 026
-- (ADD CONSTRAINT IF NOT EXISTS появился только в PG16): уже расширенный constraint (содержит
-- 'ym') не передёргивается, повторный прогон безопасен на любой версии.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_sources_network_check'
       AND conrelid = 'external_sources'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%''ym''%'
  ) THEN
    ALTER TABLE external_sources DROP CONSTRAINT external_sources_network_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_sources_network_check'
       AND conrelid = 'external_sources'::regclass
  ) THEN
    ALTER TABLE external_sources
      ADD CONSTRAINT external_sources_network_check
      CHECK (network IN ('tg', 'ig', 'ms', 'ym'));
  END IF;
END$$;
