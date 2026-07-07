# AUDIT — Multi-tenant isolation (ADR-001) + PII / GDPR

Scope: prove every tenant read/write path in AtlaVue passes an ownership/membership check and is
scoped by `channel_id` / `source_id` / `workspace_id` / `uid`; inventory PII; audit deletion
completeness; state the GDPR posture. Baseline: `origin/main` @ `f89c15e`. Method: full read of
`server/index.js`, `server/db.js`, `server/middleware/tenant.js`, `server/routes/collector.js`,
`server/collector/contract.js`, `server/migrations/*.sql`; adversarial trace of every route; every
High+ finding verified against a real Postgres (red→green) before a fix was written.

Verdict: **one High finding (F1)** — a cross-tenant *read* leak via unverified external-source
claiming — found, fixed, and regression-tested. Every other threat scenario is **resilient** (the
access contour is otherwise sound). Two documentation gaps (GDPR erasure/portability) are recorded
as recommendations.

---

## 1. Access model (how isolation is meant to work)

Three concepts (ADR-001): `external_sources` = deduplicated identity of a TG/IG property;
`workspaces`+`workspace_members` = the access boundary; `channels` = a workspace→source link.

Two enforcement helpers, and **every** tenant route funnels through one of them:

- **`db.getChannel(id, user)`** (`server/db.js:307`) returns the channel row **only** if
  `CHANNEL_ACCESS_PREDICATE` holds — `channels.owner_uid = uid` (legacy/creator, incl. the bootstrap
  central channel) **OR** the user is a member of `channels.workspace_id`. It also hides
  `status='disabled'` and attaches the caller's effective `member_role`. Routes turn `null` → 403.
- **`resolveChannel`** (`server/middleware/tenant.js:3`) reads `?channel` / `x-channel-id`, defaults to
  the caller's first `listChannels(user)` entry (membership-scoped), then calls `getChannel`. Foreign
  id → 403.
- Write-gates: **`requireWorkspaceRole(minRole)`** / **`hasWorkspaceRole`**
  (`server/middleware/tenant.js:36,44`) rank `viewer<member<admin<owner` off `member_role`.

**Read-helpers that take a bare `channelId` never re-check ownership themselves** (`getChannelHistory`,
`getLatestVelocity`, `getSnapshot`, `getMentionsArchive`, `listAnnotations`, `listIgDaily`, …). Their
safety depends on the *invariant* that the `channelId` was already resolved through `getChannel` /
`resolveChannel` / `req.ig.channelId`. That invariant was verified true for every call site (§2), and
`getChannelById` (unscoped) is used **only** by the cron and by API-key auth — never for a
user-facing tenant response (`server/db.js:325`, callers at `806`, cron).

---

## 2. Isolation matrix (endpoint × ownership-check × scope)

`RA`=requireAuth, `RS`=requireSuper, `RC`=resolveChannel(→getChannel), `RIg`=resolveIg(→getChannel),
`gC`=explicit getChannel, `wsRole`=hasWorkspaceRole. All line refs `server/index.js` unless noted.

### Tenant data — Telegram
| Endpoint | Guard | Scope key | Verdict |
|---|---|---|---|
| `GET /api/tg/channel` (1934) | RA · RC · serveSnapshot | `req.channel.id`; non-central→snapshot only | PASS |
| `GET /api/tg/mtproto/channel\|posts\|views_summary\|stats\|graphs` (2207-2281) | RA · RC · serveSnapshot | `req.channel.id`; live MTProto **central-only** | PASS |
| `GET /api/tg/mtproto/velocity` (2287) | RA · RC | `getLatestVelocity(req.channel.id)` | PASS (was **F1**, fixed) |
| `GET /api/tg/mtproto/mentions` (2319) | RA · RC · notCentral | `req.channel.id`; live search central-only | PASS |
| `GET /api/tg/mtproto/post_stats/:id` (2340) | RA · RC · notCentral | `req.channel.id` | PASS |
| `GET /api/tg/full` (2402) | RA · RC | non-central→`getSnapshot(req.channel.id)` | PASS |
| `GET /api/history/channel` (2562) | RA · RC | `getChannelHistory(req.channel.id)` | PASS (was **F1**, fixed) |
| `GET /api/history/mentions` (2571) | RA · RC | `getMentionsArchive(req.channel.id)` (`owner_channel_id`-scoped) | PASS |
| `GET /api/tg/mtproto/thumb/:id` (2371) | mediaLimiter only (unauth) | central public channel media only | PASS (by-design, §4) |
| `GET /api/tg/mtproto/channel/photo` (2389) | mediaLimiter only (unauth) | central public channel photo only | PASS (by-design, §4) |
| `GET /api/tg/mtproto/health` (2198) | RA | no tenant data | PASS |

### Tenant data — Instagram (`resolveIg`; env-account fallback superuser-only)
| Endpoint | Guard | Scope key | Verdict |
|---|---|---|---|
| `GET /api/ig/profile\|tags\|insights\|posts\|breakdowns\|online\|stories` (836-1134) | RA · RIg | `req.ig` (channel token after gC; else env=superuser; else mock) | PASS |
| `GET /api/ig/history` (1142) | RA · RIg | `listIgDaily(req.ig.channelId)` — set only after gC | PASS |
| `POST /api/ig/oauth/start` (1449) | RA · gC · wsRole(admin) | channel-bound; signed state | PASS |
| `GET /api/ig/oauth/callback` (1479) | signed state · re-gC | binds token to state channel | PASS |
| `DELETE /api/ig/oauth` (1572) | RA · gC · wsRole(admin) | `req.channel.id` | PASS |
| `GET /api/ig/oauth/status` (1586) | RA · gC | `req.channel.id` | PASS |

### Channels / keys / annotations
| Endpoint | Guard | Scope key | Verdict |
|---|---|---|---|
| `GET /api/channels` (1625) | RA | `listChannels(req.user)` (membership) | PASS |
| `POST /api/channels` (1635) | RA | `createChannel(owner_uid=req.user.uid)` | PASS |
| `DELETE /api/channels/:id` (1650) | RA | `deleteChannel(id, req.user.uid)` — **owner_uid-only** | PASS (tighter than membership; §5 note) |
| `POST /api/channels/:id/key` (1663) | RA · gC · wsRole(admin) | `id`; central rejected | PASS |
| `GET /api/channels/:id/keys` (1681) | RA · gC · wsRole(admin) | `listApiKeys(id,uid)` (admin predicate) | PASS |
| `DELETE /api/channels/:id/key/:keyId` (1694) | RA · gC · wsRole(admin) | `revokeApiKey(keyId,id,uid)` matches key↔channel | PASS |
| `GET /api/channels/:id/annotations` (1711) | RA · gC | `listAnnotations(id)` (member read) | PASS |
| `POST /api/channels/:id/annotations` (1722) | RA · gC · wsRole(member) | `createAnnotation(id,…)` | PASS |
| `DELETE …/annotations/:annId` (1740) | RA · gC · wsRole(member) | `deleteAnnotation(annId,id)` (channel-scoped) | PASS (member-level, §5 note) |

### Per-user (uid-scoped, no channel)
| Endpoint | Guard | Scope key | Verdict |
|---|---|---|---|
| `GET/PUT /api/prefs` (624/629) | RA | `getPrefs/setPrefs(req.user.uid)` | PASS |
| `GET /api/auth/me`, `POST/DELETE /api/me/avatar` (506/517/529) | RA | `req.user.uid` | PASS |
| `POST /api/auth/change-password` (643) | RA | `req.user.uid` (+ token_version bump) | PASS |
| `GET/POST/GET:id/PUT:id/DELETE:id /api/reports` (1780-1852) | RA | all `WHERE uid=req.user.uid` | PASS |
| QR: `status/start/poll/password/cancel` (2071-2141) | RA + `_qrOwns(id,uid)` binding | login id bound to uid | PASS |
| `DELETE /api/tg/qr/session` (2143) | RA | `deleteTgSession(req.user.uid)` | PASS |
| `POST /api/tg/qr/channels` (2158) | RA + own session | `owner_uid=req.user.uid` (write) | PASS write / **F1** read (fixed) |
| `POST /api/client-errors` (2634) | RA + crashLimiter | own crash; uid **hashed** | PASS |

### Superuser / trusted-cron / public
| Endpoint | Guard | Verdict |
|---|---|---|
| `GET /api/admin/users`, `PATCH /api/admin/users/:id` (658/665) | RA · RS (+ self-lockout guard) | PASS |
| `POST/GET/PATCH/DELETE /api/bugs*`, `…/claude-fix`, `…/screenshot`, `GET /api/bug-attachment/:id` (2583-2769) | RA · RS | PASS |
| `DELETE /api/cache` (2486) | RA · RS | PASS |
| `POST /api/ingest/daily` (2497) | `INGEST_TOKEN` (timing-safe compare, header-preferred) | writes central only | PASS |
| `POST /api/collector/ingest` (routes/collector.js:105) | `requireApiKey` (key hash → its own channel; central rejected) | writes `req.channel.id` only | PASS |
| `GET /api/health`, `/api/ready`, `/api/config` | public status/config, no tenant data | PASS |
| auth: register/login/google/verify/forgot/reset/resend | public + anti-enumeration + authLimiter | PASS |

Cron / no-`req` paths: `processTgQrCollection` writes to `ch.id` from the session-owner's
`listChannels` (`server/index.js:1412`); `collectIgForAccount` writes `acc.channel_id`
(`1298`); central ingest writes `getOwnerChannelId()` only. All correctly scoped.

---

## 3. Threat scenarios (card §"Threat / failure scenarios") — explicit verdicts

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 1 | IDOR via `x-channel-id`/`?channel=` → foreign id must 403 | **Resilient** | All 5 read sites route through `getChannel` (`index.js:775,1454,1573,1587`; `tenant.js:10`). `getChannelById` never used for a tenant response. |
| 2 | Central leak: non-owner must not get live `@bynotem`; default `channelId=0` must not hand central to a stranger | **Resilient** | `serveSnapshot`/`notCentral` gate live MTProto to `source='central'`; a stranger can't resolve central (not owner_uid, not workspace member) → `getChannel` null → 403; default id comes from membership-scoped `listChannels`. |
| 3 | IG env-fallback spoof: env account only for superuser/DB-off | **Resilient** | `resolveIg` gates env to `!db.enabled || role==='superuser'` (`index.js:793`); a regular user with a foreign channel gets mock. |
| 4 | Shared `source_id` cross-tenant visibility | **VULNERABLE → fixed (F1)** | Phase-B canonical reads unioned all rows by `source_id`; a claimer inherited another tenant's history/velocity. Fixed by `sameTenantSource` (§F1). |
| 5 | Races/errors: no foreign tenant served from cache under DB/decrypt error; `mtproto:*:${id}` keys can't collide | **Resilient** | Cache keys use the internal channel PK (unique per tenant); `resolveChannel` gates *before* `cacheGet`; on decrypt/DB error `resolveIg` → mock (env only for superuser). |
| 6 | RBAC write-gates; legacy rows creator-only; `deleteAnnotation` without `created_by` | **Resilient** (member-level delete is by-design) | keys/IG-connect = admin; annotations = member; legacy NULL-workspace rows are creator-only via the fallback. Any member deleting a channel annotation is intended (§5). |
| 7 | QR channels without admin re-verify: HARD-scoped `owner_uid`; can't attach a foreign channel | **Write-resilient; read was VULNERABLE → fixed (F1)** | Writes are `owner_uid`-scoped and fed only by the user's own session. But the claimed row's `source_id` fed the shared read — the leak vector of F1. Read side now workspace-bounded. |
| 8 | Token revocation: `token_version` bump invalidates old tokens immediately | **Resilient** | `requireAuth` rejects on `sess.tokenVersion !== u.token_version` (`index.js:226`); every role/status/password/revoke path bumps it (`db.js:608,616,624,632`). |
| 9 | Cron cross-tenant writes: `processTgQrCollection` writes strictly to this uid's `ch.id` | **Resilient** | Iterates the session owner's own `listChannels`, filters `source='qr'`, writes `persistTgBundle(ch.id,…)`. |
| 10 | Collector ingest: one channel's key can't write another `channel_id` | **Resilient** (write); see F1 for read | `requireApiKey`→`getChannelByApiKey` returns the key's own channel; ingest writes `req.channel.id`. (A lying collector's self-reported `channel.id` fed the F1 read leak, now closed.) |

---

## 4. Findings

| ID | Severity | CVSS 3.1 (base) | Title | Status |
|---|---|---|---|---|
| **F1** | **High** | 6.5 — `AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N` | Unverified external-source claiming → cross-tenant read of admin-only history/velocity/subscriber-count | **Fixed + regression-tested** |
| F2 | Info | — | `@bynotem` thumbnail/photo proxies are unauthenticated | Accepted by-design (public central); flag for private-channel future |
| F3 | Low | — | `deleteChannel` is `owner_uid`-only, not workspace-admin | Functionality gap, isolation-safe |
| F4 | Medium (GDPR) | — | No self-serve account/data erasure (Art. 17) or export (Art. 20) | Documented recommendation (§7) |
| F5 | Low (GDPR) | — | `deleteIgAccount`/`deleteTgSession` remove the credential but not accumulated history ("disconnect ≠ erase") | Documented recommendation |

### F1 — Unverified external-source claiming → cross-tenant read leak (High)

**Where:** `server/db.js` — the three Phase-B source-union reads: `getChannelHistory`
(`db.js:456`), `getLatestVelocity` (`db.js:1020`), `MEMBER_COUNT_COL` (`db.js:269`). Entry points:
`POST /api/tg/qr/channels` (`index.js:2158` → `createTgChannel` → `ensureChannelCanonical`) and the
collector ingest self-reported `channel.id` (`db.js:setChannelTgId`).

**Failure scenario (proven red→green):**
1. Attacker registers (self-serve) and connects any Telegram session, then calls
   `POST /api/tg/qr/channels` with `channels:[{id: <victim tg_channel_id>}]` — e.g. central
   `@bynotem`'s id (a public channel's numeric id is derivable). No proof of admin access is required.
2. `createTgChannel` → `ensureChannelCanonical` → `ensureExternalSource('tg', <victim id>)`
   **find-or-creates the SAME `source_id`** the victim's channel already uses.
3. Attacker reads `GET /api/history/channel?channel=<their new channel>` (or `…/velocity`).
   `resolveChannel` passes (they own the row). The **unbounded** source union
   `WHERE d.source_id = c.source_id` returned the **victim's** `channel_daily` rows — daily
   joins/leaves/reactions and per-post velocity, which are **admin-only** (from `GetMessageStats`,
   not public on t.me) — plus the victim's subscriber count via `memberCount`.

The QR handler's own comment asserted "a crafted/ineligible id just creates an empty self-owned row …
(no cross-tenant reach)" — true for **writes**, but Phase-B made **reads** source-shared, silently
falsifying it. The collector path is equally effective (a collector reports any `channel.id`).

**Adversarial verification:** the only refutation found was that cross-workspace source-sharing is a
*documented, unit-tested* ADR-001 acceptance criterion — i.e. the behaviour is intended for
*legitimate* co-followers. That does not refute the security defect: co-following is **unauthenticated**,
so "legitimate" and "claimed" are indistinguishable. The finding survives; its remediation is
therefore an **invariant change**, flagged for human review (below).

**Fix (`server/db.js`, helper `sameTenantSource`):** the source union now includes only rows written
by a channel in the **reader-channel's own workspace** (or by its creator — covers legacy/central
rows with `workspace_id` NULL). Own-channel rows (`d.channel_id = c.id`) are always included.
- Same-workspace co-following still shares one canonical row-set (dedup preserved).
- Cross-workspace sharing is withheld until an **access-verified follow** exists (the deferred admin
  re-listing, roadmap P2.2, which should stamp `source_id` only after Telegram confirms admin rights).
- No migration, no write-path, no schema change — pure read-predicate hardening; closes **both** the
  QR and the collector claim vectors at the read layer (defense-in-depth).

**Invariant note for the reviewer:** this narrows ADR-001's stated cross-workspace read-sharing to
same-workspace/owner **for shipped flows only** (invites/cross-workspace following are not shipped —
no legitimate flow regresses today). ADR-001 §"Security amendment" records the constraint; the two
integration tests that previously asserted cross-workspace sharing were rewritten to assert the
secure boundary. **Re-widening cross-workspace sharing MUST be gated on source-access verification.**

**Regression:** `test/tenancy.integration.test.js` — «F1: claiming a foreign external source grants
NO cross-tenant history/velocity/count read» + the rewritten «same-workspace co-follow shares … ;
cross-workspace does NOT leak (F1)» and «creation paths canonicalise …». Verified against real
Postgres: **fails on unfixed `db.js` (2/2), passes with the fix (8/8 in the suite)**.

### F2 — Unauthenticated central media proxies (Info / by-design)
`GET /api/tg/mtproto/thumb/:id` and `…/channel/photo` (`index.js:2371,2389`) are deliberately
unauthenticated (they back `<img src>` which can't send the session header). They can only ever
serve the single configured **public** central channel's media (the Python service is bound to
`@bynotem`) — no per-tenant reach. `mediaLimiter` bounds anonymous scraping. **Accepted**; revisit
with signed URLs **before** any private channel is ever proxied.

### F3 — `deleteChannel` owner-only (Low, isolation-safe)
`deleteChannel(id, uid)` filters `owner_uid=$2` (`db.js:788`), so a workspace *admin* who is not the
creator cannot delete a channel. Tighter than the rest of the RBAC surface (which uses membership),
never looser — no isolation risk; noted only for consistency.

---

## 5. RBAC notes (not defects)
- `deleteAnnotation` is member-level (any workspace member may delete any annotation on a channel
  they can access) and has no `created_by` gate — **intended**: annotations are shared channel
  markers, and `member` is the documented write tier.
- Legacy rows with `workspace_id=NULL` are creator-only via `hasWorkspaceRole`'s
  `owner_uid` fallback (`tenant.js:40`) — correct.
- `viewer` (rank 0) is correctly below `member` (rank 1), so viewers cannot write annotations/keys.

---

## 6. PII inventory

| Store | PII category | At rest | Retention | Readers | Leaves server? |
|---|---|---|---|---|---|
| `users` (`email`, `pass_hash`, `avatar_url`) | account email; credential | email plaintext; pass = **scrypt**; avatar = data-URL | account lifetime (no self-delete, F4) | auth | email → outbound Resend mail |
| `tg_sessions.session_enc` | **Telegram StringSession = FULL account access** | **encrypted** `TG_SESSION_KEY` (`lib/tg_crypto`) | until `deleteTgSession` (no auto-expiry) | daily cron + QR routes (decrypt) | **never** to client |
| `ig_accounts.access_token_enc` | IG long-lived token | **encrypted** `IG_TOKEN_KEY` (`lib/ig_crypto`) | until `deleteIgAccount` | cron + `resolveIg` (decrypt) | **never** to client |
| `email_tokens.token_hash` | verify/reset token | **sha256**; single-use + expiry | pruned on use | auth | no |
| `mentions` (`title/username/link/snippet`) | third-party channels (public posts) | plaintext | with owner channel | owner via `getMentionsArchive` | to owner only |
| `ig_tags` (`username/caption/permalink`) | third-party accounts that @-tagged us | plaintext | append + last_seen | env-account owner | to owner only |
| `raw_snapshots` (IG demographics/online/stories) | **aggregate** demographics (no individual PII) | plaintext | pruned ~400d | cron/dashboard | to owner only |
| `audit_events` (`uid`, `ip_hash`, action) | uid; **hashed** IP | ip = HMAC `IP_HASH_KEY`; uid plaintext | append (channel_id `SET NULL` on delete) | superuser | no |
| `bugs`/`bug_attachments` (crash context, screenshots) | uid **hashed** in crash; UA; user text; images | uidHash = HMAC; images raster-only + magic-byte checked | admin lifecycle | superuser | no |
| `channel_daily/posts/velocity_daily/ig_daily/ig_media_daily` | business analytics (post captions) | plaintext | ~400-730d prune | owner-workspace (post-F1) | to owner only |
| `user_prefs`, `reports` | user config | plaintext | account lifetime | owner (uid) | reports → emailed if scheduled |

**Encryption keys & blast radius:**
- `SESSION_SECRET` — signs sessions; derives `IG_STATE_KEY`, `IP_HASH_KEY`, `hashUid`. Compromise →
  forge any session **and** de-anonymize `ip_hash` / crash `uidHash`.
- `TG_SESSION_KEY` — compromise → decrypt **every** stored Telegram session = full account takeover
  of every connected user. **Highest-value secret.**
- `IG_TOKEN_KEY` — compromise → decrypt every IG token (insights-scope access).
All three are Railway env; none is logged. Client SQLite collector queue holds only outbound
payloads keyed by its own API key — no cross-tenant data.

**Logs:** observability hashes IP; error middleware logs `request_id` + message (no PII/tokens);
collector errors log `channel_id`, not payload; OAuth/token flows log outcome flags, never tokens.
No PII-in-logs issue found.

---

## 7. Deletion completeness & GDPR

**`deleteChannel(id, uid)` cascade — complete.** Every tenant child table FK is
`ON DELETE CASCADE`: `channel_daily`, `posts`, `velocity_daily`, `mentions`, `api_keys`,
`channel_snapshots` (001), `ingest_receipts`, `collector_status` (002), `ig_accounts` (003),
`chart_annotations` (006), `raw_snapshots`, `ig_daily`, `ig_media_daily` (008). `audit_events` is
deliberately `ON DELETE SET NULL` (002) — keeps the audit trail, drops the channel ref. `ig_tags` is
global (known "not yet per-channel" limitation). **No orphaned tenant rows.**

**Cache after delete — no leak (card hypothesis refuted).** `deleteChannel` does not purge the
in-memory `cache`, but every read route runs `resolveChannel`/`getChannel` **before** `cacheGet`, so a
deleted channel returns 403 and its stale entries are never served (they expire in ≤10 min). SERIAL
ids are never reused, so a new channel can't inherit them.

**Shared-source residue — bounded and now invisible.** Sibling channels' rows under a shared source
survive a delete (Phase-B by-design); post-F1 they were never cross-workspace-visible anyway.

**GDPR posture:**
- **Art. 15 (access)** — partial: the dashboard surfaces a user's data; no machine-readable export.
- **Art. 17 (erasure)** — **gap (F4):** no self-serve account deletion. Admin `setUserStatus('disabled')`
  suspends but does not erase. Recommended: an authenticated `DELETE /api/me` that (a) `deleteTgSession`
  + `deleteIgAccount` (revoke credentials first), (b) `DELETE FROM users WHERE id=uid` (cascades
  workspaces→channels→all tenant data; `audit_events` retains a channel-less, uid-nulled trail per
  retention policy), (c) `cache.clear()`/`igCachePurge`. Destructive + product-policy-laden → **left
  as a documented design, not shipped autonomously.**
- **Art. 20 (portability)** — gap: no export endpoint. Recommended: `GET /api/me/export` streaming the
  user's channels + history + reports as JSON.
- **"Disconnect ≠ erase" (F5):** `deleteIgAccount`/`deleteTgSession` drop the credential but keep
  accumulated `ig_daily`/`channel_daily`/`raw_snapshots`. Recommend a "disconnect **and** wipe history"
  option.
- **Backups/PITR:** per `ops/BACKUP_RESTORE.md`, an erasure does not propagate into the PITR window;
  document the residual (data ages out of backups per the retention window) in the privacy policy.

---

## 8. Deliverables & status
- This document (matrix + threats + findings + PII map + deletion audit + GDPR).
- **Fix PR** (branch `claude/tenancy-source-read-isolation`): `server/db.js` `sameTenantSource`
  hardening; `server/index.js` corrected QR comment; `ops/ADR-001-tenancy.md` security amendment;
  rewritten + new regression tests. `npm run check` green; integration suite green on the local stand
  (8/8), red→green verified.
- **Open items for the human:** ratify the ADR invariant narrowing (F1); decide P2.2 verified-follow
  as the re-widening gate; prioritize GDPR erasure/export (F4) and disconnect-and-wipe (F5).
