-- 028_ai_chats.sql
-- AI-ассистент (STEEP-паттерн): личные диалоги пользователя с ассистентом поверх его же
-- аналитики. Скоуп — ПОЛЬЗОВАТЕЛЬ (не workspace): чат, как Главная, персональная поверхность;
-- аналитику ассистент читает только через ForActor-инструменты с ownership-проверкой на каждый
-- вызов (aiChatService), поэтому граница workspace обеспечивается на слое чтения, а не
-- хранением диалога.
--
--   ai_chats         — диалог: владелец + заголовок (из первого вопроса) + updated_at для
--                      сортировки «недавних чатов».
--   ai_chat_messages — сообщения диалога. content — плоский текст; tool_trace — JSONB-след
--                      вызовов инструментов ассистента (прозрачность в UI, НЕ переигрывается
--                      в модель); error — пометка прерванного/сбойного ответа.
--   ai_usage_daily   — дневной счётчик вопросов и токенов per-user: дешёвый quota-гейт
--                      (AI_DAILY_MESSAGE_LIMIT) и материал для будущего биллинга.
--
-- Удаление пользователя каскадит его чаты и usage; удаление чата — его сообщения.
-- Идемпотентно per migration runner (IF NOT EXISTS; CHECK'и живут в CREATE TABLE).

CREATE TABLE IF NOT EXISTS ai_chats (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_chats_user_recency_idx ON ai_chats(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id            SERIAL PRIMARY KEY,
  chat_id       INTEGER NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content       TEXT NOT NULL,
  tool_trace    JSONB,
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_chat_messages_chat_idx ON ai_chat_messages(chat_id, id);

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  messages      INTEGER NOT NULL DEFAULT 0,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
