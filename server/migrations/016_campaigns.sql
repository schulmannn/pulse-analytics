-- 016_campaigns.sql
-- «Кампании и группы контента»: пользователь объединяет публикации из доступных ему
-- источников (TG-посты из архива `posts`, IG-медиа из live-листинга + `ig_media_daily`)
-- в смысловые группы («Запуск продукта», «Black Friday», …) и смотрит их сводку.
--
-- Модель:
--   campaigns      — кампания живёт в WORKSPACE (ADR-001): читают все участники,
--                    изменяют member/admin/owner (viewer — read-only). Workspace определяется
--                    выбранным источником; клиент не передаёт workspace_id напрямую.
--   campaign_posts — membership: платформа + внутренний channel_id + УСТОЙЧИВЫЙ post id
--                    (tg → posts.post_id::text, ig → media_id). Один пост может состоять
--                    в нескольких кампаниях (PK включает campaign_id). Метрики НЕ
--                    копируются — читаются join'ом из posts / ig_media_daily на лету;
--                    храним только неизменяемые описательные поля (published_at,
--                    media_type, caption-превью): для IG даты/формата в БД больше нигде
--                    нет (live Graph API), без них невозможны таймлайн и разбивки.
--
-- Удаление кампании каскадит ТОЛЬКО membership (campaign_posts.campaign_id) — сами
-- публикации не трогаются. Удаление канала уносит его membership-строки (иначе висячий
-- channel_id). Идемпотентно per migration runner (IF NOT EXISTS; CHECK'и живут в
-- CREATE TABLE и применяются только при создании).

CREATE TABLE IF NOT EXISTS campaigns (
  id           SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  color        TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  start_date   DATE,
  end_date     DATE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS campaigns_workspace_idx ON campaigns(workspace_id);
-- Composite keys make the workspace boundary enforceable by campaign_posts foreign keys, not only
-- by application code. `id` remains the public identifier; the extra unique indexes are FK targets.
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_id_workspace_uniq ON campaigns(id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS channels_id_workspace_uniq ON channels(id, workspace_id);
-- Дубликат имени внутри воркспейса — 409 на уровне БД (case-insensitive), а не только UI.
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_ws_name_uniq ON campaigns(workspace_id, lower(name));

CREATE TABLE IF NOT EXISTS campaign_posts (
  campaign_id  INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  network      TEXT NOT NULL CHECK (network IN ('tg','ig')),
  channel_id   INTEGER NOT NULL,
  post_ref     TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  media_type   TEXT,
  caption      TEXT,
  added_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT campaign_posts_campaign_workspace_fk
    FOREIGN KEY (campaign_id, workspace_id)
    REFERENCES campaigns(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT campaign_posts_channel_workspace_fk
    FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channels(id, workspace_id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, network, channel_id, post_ref)
);
-- Обратный lookup: «в каких кампаниях состоит пост» (бейджи в списке контента) и
-- фильтрация контента по кампании.
CREATE INDEX IF NOT EXISTS campaign_posts_post_idx ON campaign_posts(network, channel_id, post_ref);
