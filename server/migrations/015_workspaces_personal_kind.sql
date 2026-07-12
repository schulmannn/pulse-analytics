-- 015_workspaces_personal_kind.sql
-- Finding 1 (P1): ensurePersonalWorkspace делал SELECT-then-INSERT, а на workspaces.owner_uid был
-- только обычный индекс (010_workspaces_sources.sql), не unique. Гонка двух коннектов НОВОГО юзера
-- (два одновременных подключения источника) могла создать ДВА personal-воркспейса; дальше
-- `ORDER BY id LIMIT 1` молча выбирал один, а каналы/членство разъезжались между ними.
--
-- Вводим `kind` (personal|team) и partial-unique по owner_uid WHERE kind='personal': один личный
-- воркспейс на владельца гарантирован БД, при этом будущие team-воркспейсы того же владельца не
-- блокируются (forward-compatible вариант из ревью). ensurePersonalWorkspace переходит на
-- INSERT ... ON CONFLICT DO NOTHING (см. channelsRepo).

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'personal';

-- Схлопнуть уже существующие дубли personal-воркспейсов (если гонка успела их создать до индекса):
-- оставляем самый старый (min id), переносим на него каналы, чистим лишнее членство и дубли. В норме
-- (дублей нет) все три запроса трогают 0 строк. Только channels(NO ACTION) и workspace_members
-- (CASCADE) ссылаются на workspaces(id) — других FK нет.
UPDATE channels c SET workspace_id = k.keep_id
  FROM workspaces w
  JOIN (SELECT owner_uid, min(id) AS keep_id FROM workspaces WHERE kind = 'personal' GROUP BY owner_uid) k
    ON k.owner_uid = w.owner_uid
 WHERE c.workspace_id = w.id AND w.kind = 'personal' AND w.id <> k.keep_id;

DELETE FROM workspace_members m
  USING workspaces w
  JOIN (SELECT owner_uid, min(id) AS keep_id FROM workspaces WHERE kind = 'personal' GROUP BY owner_uid) k
    ON k.owner_uid = w.owner_uid
 WHERE m.workspace_id = w.id AND w.kind = 'personal' AND w.id <> k.keep_id;

DELETE FROM workspaces w
  USING (SELECT owner_uid, min(id) AS keep_id FROM workspaces WHERE kind = 'personal' GROUP BY owner_uid) k
 WHERE w.kind = 'personal' AND w.owner_uid = k.owner_uid AND w.id <> k.keep_id;

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_personal_owner_uniq
  ON workspaces (owner_uid) WHERE kind = 'personal';
