-- 018_channel_mention_settings.sql
-- Per-channel Telegram mention rules. Раньше правила поиска упоминаний были ГЛОБАЛЬНЫМИ:
-- клиент-специфичные захардкоженные запросы в mtproto/service.py (_DEFAULT_MENTION_QUERIES) плюс
-- одна легаси-сессия на всех. Это не давало вести несколько каналов безопасно — запросы, квота и
-- идентичность архива смешивались. Теперь каждый канал хранит СВОИ правила, а живой поиск идёт
-- через управляемую (зашифрованную) QR-сессию вызывающего пользователя.
--
-- Одна строка на channels.id (PK = FK, ON DELETE CASCADE): удаление канала уносит его правила.
-- ОТСУТСТВИЕ строки = канал не настроен (никаких сидов Atlavue/notem — правила добавляет владелец).
--
-- include_terms  — что искать (ЛЮБОЙ из терминов — ANY-семантика). Пусто = не настроено.
-- exclude_terms  — шумовые термины, отменяют совпадение include.
-- exclude_sources— usernames/числовые id каналов, которые НЕ считаются упоминанием (свой бренд и т.п.).
-- match_mode     — 'contains' (подстрока) или 'word' (целое слово/фраза, Unicode-aware).
-- Массивы NOT NULL DEFAULT '{}' — «настроен» определяется наличием include-терминов, а не строки.
CREATE TABLE IF NOT EXISTS channel_mention_settings (
  channel_id      INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  include_terms   TEXT[]      NOT NULL DEFAULT '{}',
  exclude_terms   TEXT[]      NOT NULL DEFAULT '{}',
  exclude_sources TEXT[]      NOT NULL DEFAULT '{}',
  match_mode      TEXT        NOT NULL DEFAULT 'contains',
  revision        BIGINT      NOT NULL DEFAULT 1,
  updated_by      INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Именованный CHECK — идемпотентно (ADD CONSTRAINT IF NOT EXISTS только в PG16, поэтому гейтим
-- через каталог, чтобы миграция была безопасно-повторяемой на любой версии).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'channel_mention_settings_match_mode_chk'
       AND conrelid = 'channel_mention_settings'::regclass
  ) THEN
    ALTER TABLE channel_mention_settings
      ADD CONSTRAINT channel_mention_settings_match_mode_chk
      CHECK (match_mode IN ('contains', 'word'));
  END IF;
END$$;
