-- 035_mention_notify.sql
-- Доставка упоминаний в личку Telegram через бота. Поиск уже существует (018 — правила
-- per-channel, live-поиск через managed-сессию пользователя); этот слой добавляет ДОСТАВКУ:
-- кому слать (личный чат с ботом) и по каким каналам (личная подписка).
--
-- tg_notify_bindings — привязка uid → личный чат с ботом. Бот НЕ может написать пользователю
-- первым, поэтому привязка идёт deep-link'ом t.me/<bot>?start=<token>: пользователь жмёт Start,
-- вебхук получает /start <token> и заполняет chat_id. Токен — bearer привязки, поэтому в БД
-- хранится ТОЛЬКО его sha256 (как email-токены в auth): утечка строки не даёт привязать чужой чат.
-- chat_id NULL = привязка начата (ссылка выдана), но Start ещё не нажат.
CREATE TABLE IF NOT EXISTS tg_notify_bindings (
  uid             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id         BIGINT,
  tg_user_id      BIGINT,
  username        TEXT,
  link_token_hash TEXT,
  link_expires_at TIMESTAMPTZ,
  bound_at        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Вебхук резолвит токен без uid — нужен уникальный индекс по хешу (частичный: NULL-хеши не индексируем).
CREATE UNIQUE INDEX IF NOT EXISTS tg_notify_bindings_token_uniq
  ON tg_notify_bindings(link_token_hash) WHERE link_token_hash IS NOT NULL;

-- mention_notify_subscriptions — личная подписка «слать мне новые упоминания этого канала».
-- Скоуп (channel_id, uid): несколько членов воркспейса могут подписаться независимо; поиск в
-- джобе идёт через СОБСТВЕННУЮ managed-сессию подписчика (его квота searchPosts), поэтому
-- подписка не требует admin-роли — достаточно видеть канал (channelAccessSql в репо).
--
-- last_notified_at — watermark доставки: NULL = ещё ни разу не слали (первый прогон seed'ится
-- сводкой, без пер-карточек — иначе свежая подписка выплюнет весь архив). last_error — только
-- безопасный код из allow-list джоба (никакого upstream-текста), NULL после успешного прогона.
CREATE TABLE IF NOT EXISTS mention_notify_subscriptions (
  channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  uid              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  last_run_at      TIMESTAMPTZ,
  last_notified_at TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, uid)
);
-- Ежедневный джоб ходит только по включённым подпискам.
CREATE INDEX IF NOT EXISTS mention_notify_subscriptions_enabled_idx
  ON mention_notify_subscriptions(uid) WHERE enabled;
