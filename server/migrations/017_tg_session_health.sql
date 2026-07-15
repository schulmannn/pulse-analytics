-- 017_tg_session_health.sql
-- Connection-health для управляемых Telegram QR-сессий. Раньше tg_sessions хранила только
-- сам факт подключения (session_enc) — но StringSession может протухнуть (пользователь снёс
-- сессию в Telegram, сменил пароль, 2FA-ревок), и тогда ночной сбор QR-каналов начинал молча
-- падать с session_unauthorized, а UI продолжал показывать «подключено». Нужен явный,
-- НЕ-секретный слой здоровья, который выставляет сборщик, а /api/tg/qr/status отдаёт клиенту,
-- чтобы показать CTA «переподключить».
--
-- Только не-секретные поля: НИКАКОГО upstream-текста ошибки и НИКАКОГО session-материала —
-- last_error_code хранит лишь allow-list-код (см. integrationsRepo.recordTgSessionFailure).
--
-- connection_state — валидируемый набор:
--   healthy         — последний реальный сбор прошёл успешно;
--   reauth_required — сессия недействительна (auth-ошибка), нужен повторный QR-логин;
--   degraded        — реальные попытки были, ни одна не удалась, но и auth-ошибки не было
--                     (upstream/flood/сеть) — временная деградация, переподключение не требуется;
--   unknown         — ещё не собирали (дефолт только для существующих строк; новый QR-вход пишет healthy).
ALTER TABLE tg_sessions ADD COLUMN IF NOT EXISTS connection_state TEXT NOT NULL DEFAULT 'unknown';
-- Optimistic generation guard: reconnect increments it, so a late result from the previous encrypted
-- session cannot overwrite the health of the freshly connected one.
ALTER TABLE tg_sessions ADD COLUMN IF NOT EXISTS session_version  BIGINT NOT NULL DEFAULT 1;
ALTER TABLE tg_sessions ADD COLUMN IF NOT EXISTS last_attempt_at   TIMESTAMPTZ;
ALTER TABLE tg_sessions ADD COLUMN IF NOT EXISTS last_success_at   TIMESTAMPTZ;
ALTER TABLE tg_sessions ADD COLUMN IF NOT EXISTS last_error_code   TEXT;
ALTER TABLE tg_sessions ADD COLUMN IF NOT EXISTS last_error_at     TIMESTAMPTZ;

-- Именованный CHECK — идемпотентно (ADD CONSTRAINT IF NOT EXISTS появился только в PG16,
-- поэтому гейтим через каталог, чтобы миграция была безопасно-повторяемой на любой версии).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'tg_sessions_connection_state_chk'
       AND conrelid = 'tg_sessions'::regclass
  ) THEN
    ALTER TABLE tg_sessions
      ADD CONSTRAINT tg_sessions_connection_state_chk
      CHECK (connection_state IN ('healthy', 'reauth_required', 'degraded', 'unknown'));
  END IF;
END$$;
