-- ── МойСклад connection (JSON API 1.2) — per-channel ─────────────────────────
-- Одна учётка МойСклада на канал/тенант, зеркально ig_accounts (003): токен доступа
-- хранится ТОЛЬКО шифрованным (AES-256-GCM через MS_TOKEN_KEY) — никогда в plaintext.
-- ms_account_id — accountId из GET /context/employee (стабильная идентичность
-- аккаунта, по ней дедупятся повторные connect), org_name — имя первой организации
-- (витринное имя источника).
CREATE TABLE IF NOT EXISTS ms_accounts (
  channel_id       INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  ms_account_id    TEXT NOT NULL,
  org_name         TEXT,
  access_token_enc TEXT NOT NULL,            -- AES-256-GCM, формат: ivHex:tagHex:cipherHex
  source_id        INTEGER REFERENCES external_sources(id),
  connected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- external_sources.network родился с CHECK (network IN ('tg','ig')) (миграция 010, авто-имя
-- external_sources_network_check) — без расширения ensureExternalSource('ms', …) падал бы на
-- первой же записи canonical-идентичности склада. ADD CONSTRAINT IF NOT EXISTS появился только
-- в PG16, поэтому оба шага гейтим через каталог: повторный прогон безопасен на любой версии,
-- а уже расширенный constraint (содержит 'ms') не передёргивается.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_sources_network_check'
       AND conrelid = 'external_sources'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%''ms''%'
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
      CHECK (network IN ('tg', 'ig', 'ms'));
  END IF;
END$$;
