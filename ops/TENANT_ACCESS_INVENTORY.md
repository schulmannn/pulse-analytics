# Tenant Access Inventory

Status: reviewed for the P0 multi-tenant access audit on 2026-07-05.
Source of truth: `ops/ADR-001-tenancy.md`.

## Boundary Model

- User-owned rows use `uid` from the authenticated session. Never accept a user id from request params/body for prefs, reports, sessions, avatars or account settings.
- Channel/source rows use workspace membership. Read paths must resolve the channel through `db.getChannel(id, req.user)` or `resolveChannel`; write paths must additionally check `hasWorkspaceRole` / `requireWorkspaceRole`.
- Internal cron/collector loops may use unscoped helpers (`getChannelById`, `listIgAccounts`, `listTgSessions`, scheduled reports) only when the route is not user-addressable.
- Public unauthenticated routes are limited to explicitly documented low-sensitivity media proxies for public central-channel images.

## Query Inventory

| Surface | Route/helper | Tenant gate | Notes |
| --- | --- | --- | --- |
| Auth profile/avatar | `/api/auth/me`, `/api/me/avatar` | session `req.user.uid` | No foreign uid input. |
| User prefs / widget configs | `/api/prefs`, `getPrefs`, `setPrefs` | `uid=$session.uid` | Personal dashboard/widget prefs only. |
| Reports | `/api/reports*`, report DB helpers | `uid=$session.uid` | Integration tests deny cross-uid fetch/update/delete/list. |
| Channel list/read | `/api/channels`, `resolveChannel`, `getChannel`, `listChannels` | `workspace_members` or legacy `owner_uid` | Read boundary for all channel-scoped data. |
| Channel create/delete | `/api/channels` | create uses session uid; delete is owner-only | Delete remains conservative until workspace management UX ships. |
| Collector API keys | `/api/channels/:id/key*` | `getChannel` + workspace admin; DB helper also checks admin role | Standing write credentials; route `channelId` must match key channel on revoke. |
| Collector status/snapshots | `getCollectorStatus`, `getSnapshot` behind resolved channel | membership-resolved channel | Freshness status is visible to workspace readers, denied to outsiders. |
| TG/IG analytics | `/api/tg/*`, `/api/ig/*` | `resolveChannel` / `resolveIg` | Data reads are channel-scoped before cache/upstream calls. |
| IG OAuth | `/api/ig/oauth*` | signed state + `getChannel` + admin for destructive actions | Callback validates state before token persistence. |
| QR sessions | `/api/tg/qr/*`, `tg_sessions` helpers | session `uid`; QR ids bound to starter uid | Encrypted sessions never leave server. |
| Annotations | `/api/channels/:id/annotations*` | `getChannel` + member role for writes | Reads require channel access. |
| Admin/bugs/cache | `/api/admin/*`, `/api/bugs*`, `/api/cache` | `requireSuper` | Not tenant-addressable by regular users. |
| Ingest | `/api/ingest/daily` | API key maps to one channel | Collector credentials are per channel. |
| Public media proxy | `/api/tg/mtproto/thumb/*`, `/api/tg/mtproto/channel/photo` | unauthenticated by design, rate-limited | Only public central-channel media; use signed URLs before private channels. |

## Reviewer Checklist

- Does the route require `requireAuth` unless it is intentionally public and documented here?
- If a request names `channel`, `channel_id`, `source`, report id or widget/prefs data, is the lookup scoped by `req.user.uid` or workspace membership before returning data?
- For channel writes, is there an explicit role check (`member`, `admin`, or `owner`) after `db.getChannel` / `resolveChannel`?
- Are raw DB helpers with no tenant predicate clearly internal-only, and not called directly from user-addressable routes?
- Do updates/deletes bind both object id and tenant id in SQL (`WHERE uid=$session.uid AND id=$id`, or matching `channel_id`)?
- Are tests added for the denial case: authenticated user from another workspace/user cannot fetch, update, delete, list or infer the object?
