-- 037_workspace_invites.sql
-- Приглашения в воркспейс: раздел «Команда» в /settings был витриной без бэкенда (ростер жил в
-- localStorage, письма не уходили, доступ не выдавался). Здесь появляется недостающее звено между
-- уже существующими workspaces/workspace_members (миграции 010/015) и почтой (Resend, verify/reset).
--
-- Токен хранится ТОЛЬКО хешем (sha256), как email_tokens: дамп базы не даёт рабочих ссылок.
-- Роль 'owner' сознательно вне CHECK — владелец приходит из workspaces.owner_uid, его не приглашают.
-- Forward-only + идемпотентно.

CREATE TABLE IF NOT EXISTS workspace_invites (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash TEXT NOT NULL,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_uid INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ
);

-- Приём приглашения ходит по токену → уникальный индекс и точка входа одновременно.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_token_uniq
  ON workspace_invites (token_hash);

-- Одно ЖИВОЕ приглашение на (воркспейс, email). Повторное «Пригласить» перевыпускает ссылку
-- поверх той же строки (ON CONFLICT), а не плодит параллельные токены в разных письмах.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_pending_uniq
  ON workspace_invites (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Список приглашений воркспейса (экран «Команда»).
CREATE INDEX IF NOT EXISTS workspace_invites_workspace_idx
  ON workspace_invites (workspace_id, created_at DESC);
