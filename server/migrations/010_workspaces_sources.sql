-- Tenancy phase A (ops/ADR-001-tenancy.md): workspaces as the access boundary, external_sources as
-- the deduplicated identity of a TG/IG property, channels demoted to a workspace→source link.
-- ADDITIVE-ONLY + idempotent backfills — rollback is a git revert (ops/BACKUP_RESTORE.md §4).

CREATE TABLE IF NOT EXISTS workspaces (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  owner_uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces(owner_uid);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, uid)
);
CREATE INDEX IF NOT EXISTS workspace_members_uid_idx ON workspace_members(uid);

CREATE TABLE IF NOT EXISTS external_sources (
  id SERIAL PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('tg', 'ig')),
  external_id TEXT NOT NULL,
  username TEXT,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (network, external_id)
);

ALTER TABLE channels ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id);
ALTER TABLE channels ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES external_sources(id);
CREATE INDEX IF NOT EXISTS channels_workspace_idx ON channels(workspace_id);
CREATE INDEX IF NOT EXISTS channels_source_idx ON channels(source_id);

-- The IG attachment of a (possibly TG) channel is its OWN canonical source (hybrid = two sources).
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES external_sources(id);

-- ── Backfill (idempotent) ────────────────────────────────────────────────────────────────────

-- One personal workspace per existing user.
INSERT INTO workspaces (name, owner_uid)
SELECT split_part(u.email, '@', 1), u.id
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_uid = u.id);

INSERT INTO workspace_members (workspace_id, uid, role)
SELECT w.id, w.owner_uid, 'owner' FROM workspaces w
ON CONFLICT (workspace_id, uid) DO NOTHING;

-- Channels join their creator's personal workspace. (The ownerless bootstrap 'central' channel
-- keeps workspace_id NULL until adoption — code falls back to the legacy owner_uid check there.)
UPDATE channels c SET workspace_id = w.id
FROM workspaces w
WHERE c.workspace_id IS NULL AND c.owner_uid IS NOT NULL AND w.owner_uid = c.owner_uid;

-- Canonical TG sources from the channels that know their platform id.
INSERT INTO external_sources (network, external_id, username, title)
SELECT DISTINCT ON (c.tg_channel_id) 'tg', c.tg_channel_id::text, c.username, c.title
FROM channels c
WHERE c.tg_channel_id IS NOT NULL
ORDER BY c.tg_channel_id, c.id
ON CONFLICT (network, external_id) DO NOTHING;

UPDATE channels c SET source_id = s.id
FROM external_sources s
WHERE c.source_id IS NULL
  AND c.tg_channel_id IS NOT NULL
  AND s.network = 'tg' AND s.external_id = c.tg_channel_id::text;

-- Canonical IG sources from connected IG accounts.
INSERT INTO external_sources (network, external_id, username)
SELECT DISTINCT ON (a.ig_user_id) 'ig', a.ig_user_id, a.username
FROM ig_accounts a
WHERE a.ig_user_id IS NOT NULL
ORDER BY a.ig_user_id, a.channel_id
ON CONFLICT (network, external_id) DO NOTHING;

UPDATE ig_accounts a SET source_id = s.id
FROM external_sources s
WHERE a.source_id IS NULL
  AND a.ig_user_id IS NOT NULL
  AND s.network = 'ig' AND s.external_id = a.ig_user_id;

-- Standalone IG channels (source='ig', no TG identity) canonicalise through their IG account.
UPDATE channels c SET source_id = a.source_id
FROM ig_accounts a
WHERE c.source_id IS NULL AND c.tg_channel_id IS NULL AND a.channel_id = c.id AND a.source_id IS NOT NULL;
