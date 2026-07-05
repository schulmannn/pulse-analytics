# ADR-001 — Tenancy: canonical sources + workspaces

Status: **accepted** (2026-07-04, autonomous per owner's go-ahead; data = test accounts only).
Implements the roadmap P0 pair «Canonical social-source model» + «Real workspace/team permissions».

## Context

Today tenancy is `channels.owner_uid`: a channel row is simultaneously (a) the identity of an
external Telegram/Instagram property, (b) the container of its collected data (`channel_daily`,
`posts`, … keyed by `channel_id`), and (c) the access boundary (resolveChannel checks owner).
Consequences: two colleagues connecting the same @channel produce two disconnected copies of the
same external property (double collection, double storage, diverging history), and there is no
team concept — sharing means sharing an account.

## Decision

Three concepts, split cleanly:

1. **`external_sources`** — the identity of an external property, global and deduplicated:
   `UNIQUE (network, external_id)` where network ∈ {tg, ig} and external_id is the platform's own
   id (`tg_channel_id`, `ig_user_id`). Collection, caching and metric storage converge on
   `source_id`.
2. **`workspaces` + `workspace_members`** — the access boundary. Every user gets a personal
   workspace (backfilled); roles are `owner | admin | member | viewer`. Invites/UI ship later
   (separate roadmap cards); the ENFORCEMENT ships now.
3. **`channels`** — demoted to a *link*: «this workspace follows this source» (+ its per-workspace
   settings: title override, status, collector keys). `channels.workspace_id` and
   `channels.source_id` are backfilled; `owner_uid` stays as creator-of-record and as the legacy
   fallback boundary until every row has a workspace.

A hybrid row (a TG channel with an attached IG account) maps to TWO canonical sources:
`channels.source_id` carries the TG identity, `ig_accounts.source_id` the IG identity.

### Data placement (phased)

- **Phase A (this change)** — identity + enforcement. New tables, backfill, membership-aware
  `getChannel/listChannels`, `requireWorkspaceRole` helper. No behaviour change for a
  single-user installation beyond the new tables.
- **Phase B (this change)** — source-keyed reads. `source_id` columns (nullable, backfilled,
  indexed `(source_id, day DESC)`) on `channel_daily`, `posts`, `velocity_daily`, `mentions`,
  `ig_daily`, `ig_media_daily`; history/posts/mentions reads go through the channel's source and
  de-duplicate with `DISTINCT ON` — so two channels linked to one source see ONE canonical
  row-set (the roadmap acceptance) even while both still write their own rows.
- **Phase C (later, separate card)** — source-keyed writes: collector/ingest upserts flip their
  conflict targets to `(source_id, day|post_id)`, per-source collection scheduling dedupes the
  actual fetching («Collector/job dedupe» card), duplicate legacy rows get pruned, and the unique
  source-level indexes become enforceable. Cache keys move to `source_id` («Cache hardening»).

### Migration safety

Per ops/BACKUP_RESTORE.md conventions: both migrations are **additive-only** (new tables, nullable
columns, non-unique indexes, idempotent backfills) — rollback is `git revert`, no restore needed.
The backfills re-run harmlessly (`ON CONFLICT DO NOTHING` / `WHERE … IS NULL`).

## Consequences

- The «second colleague follows the same channel» flow becomes: find-or-create the external
  source, create a channels-link in their workspace → history is instantly shared on read.
- Every future endpoint MUST resolve access through workspace membership (checklist: use
  `resolveChannel`/`requireWorkspaceRole`, never raw `owner_uid`). The multi-tenant audit card
  verifies this per-query.
- `jobs` idempotency keys (ADR-002 below in ops/, shipped together) can scope on
  `source:<id>` — collection work becomes dedupable per external property, not per follower.
- Until Phase C, storage for a shared source is still duplicated per following channel — an
  accepted, bounded cost (reads are already canonical; writes converge in C).

## Rejected alternatives

- **Full rewrite of data tables to source_id-only in one shot** — needs write-path + collector
  contract + conflict-target changes at once; violates the additive-first rollback convention and
  couples this change to the collector fleet. Phased instead.
- **workspace_sources join table now** — the channels row *already is* the (workspace, source)
  link including its settings; a second join table would duplicate it. Revisit only if a
  workspace ever needs to follow a source twice.
- **Roles as booleans / separate permission tables** — a single enum role on membership covers
  the near-term matrix (owner/admin manage, member edits, viewer reads); the permission-matrix
  card adds negative tests, not new storage.
