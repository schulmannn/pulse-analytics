# SECURITY_AUDIT.md — AtlaVue (pulse-analytics)

End-to-end, think-hard security audit + STRIDE threat-model of the whole platform (web/Express +
MTProto + collector + Postgres + Claude bug-fix pipeline) at a 10 000-user horizon on Railway.
Baseline: `origin/main` @ `f89c15e`. Method: full read of every subsystem in scope, adversarial
trace of each trust boundary, each of the 12 threat scenarios given an explicit verdict tied to
`file:line`, every High+ finding adversarially verified before a fix was written.

**Verdict:** the platform is well-built — stateless auth, tenancy, ingest, MTProto and secrets are
hardened. **One High finding (S1)** — prompt-injection into the write-capable Claude CI pipeline,
plantable by any authenticated user — is found, fixed, and regression-tested in this PR. Two Low/Info
items are documented as recommendations. The tenancy read-leak (F1) was found and fixed in the prior
tenancy-isolation audit (PR #56) and is cross-referenced here.

---

## 1. Trust boundaries & STRIDE summary

```
        ┌─────────┐  x-session-token (HMAC)   ┌──────────────┐  x-internal-token   ┌──────────────┐
        │ Browser │ ───────────────────────▶ │  Web/Express │ ─────────────────▶ │  MTProto/py  │
        └─────────┘   CSP · CORS(off) · RL     │ (server/*)   │  (fail-closed)      │ (Telethon)   │
             ▲                                  └──────┬───────┘                     └──────────────┘
             │ PR (human merge)                        │ parameterized SQL · SSL
   ┌─────────┴─────────┐  repository_dispatch    ┌─────▼──────┐        ┌───────────────┐
   │  GitHub Action    │ ◀───────────────────────│  Postgres  │        │ Collector(py) │──┐
   │ (claude-bugfix)   │   (POST /claude-fix)     └────────────┘        └───────────────┘  │ x-api-key
   └───────────────────┘                                                     ▲             │ (sha256)
                                                                             └─────────────┘→ Web
```

| Boundary | Spoofing | Tampering | Info-disclosure | DoS | EoP |
|---|---|---|---|---|---|
| Browser↔Web | HMAC session, unforgeable (auth.js) | body validators, JSON caps | F1 (fixed PR#56); err.stack server-only | per-uid RL, body caps | RBAC + `token_version` |
| Web↔MTProto | `x-internal-token` **fail-closed** `compare_digest` | — | session never logged (`/qr/collect`) | `_STATS_LOCK`, QR pending cap 40 | internal-only network |
| Web↔Postgres | — | parameterized queries throughout | SSL smart-default (internal=off) | pool ceiling (PGPOOL_MAX) | ownership predicates |
| Collector↔Web | 192-bit API key, sha256 at rest | idempotency + `payload_hash` | — | `MAX_ROWS`/`MAX_SNAPSHOT_BYTES`, RL 60/15m | `channel_id` from key, central rejected |
| GitHubAction↔Repo | dispatch needs `GITHUB_DISPATCH_TOKEN` | **S1: prompt-injection (fixed)** | secrets in runner env | concurrency group | PR-only, human merge |

---

## 2. Findings

| ID | Severity | CVSS 3.1 | Title | Status |
|---|---|---|---|---|
| **S1** | **High** | 7.3 — `AV:N/AC:H/PR:L/UI:R/S:C/C:H/I:H/A:L` | Prompt-injection into the write-capable `claude-bugfix` pipeline, plantable by any authenticated user via crash telemetry | **Fixed + tested (this PR)** |
| S2 | Low | 3.5 — `AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N` | `INGEST_TOKEN` accepted as `?token=` query param → token in proxy/access logs | Documented — recommend removal |
| S3 | Info | — | `claude-bugfix.yml` grants `issues: write` (likely unused) — least-privilege | Recommendation |
| F1 (x-ref) | High | 6.5 | Shared-`source_id` cross-tenant read leak | Fixed in **PR #56** (tenancy audit) |
| F2 (x-ref) | Info | — | Unauthenticated central media proxies (`thumb`/`photo`) | Accepted by-design (public central only) |

### S1 — Prompt-injection into the Claude bug-fix pipeline (High)

**Where:** `.github/workflows/claude-bugfix.yml` (interpolates `client_payload.text`/`context` into the
agent prompt) fed by `server/index.js` `POST /api/bugs/:id/claude-fix` (`index.js:2711`), whose bug
`text`/`context` for a **crash** row are attacker-controlled via `POST /api/client-errors`
(`index.js:2650` — `requireAuth` only, **not** `requireSuper`).

**Trust-boundary crossing:** the workflow runs `anthropics/claude-code-action` with
`permissions: contents: write, pull-requests: write, issues: write` and `ANTHROPIC_API_KEY`
(`claude-bugfix.yml:10-13,26-28`). The dispatched bug text/context are interpolated straight into its
prompt (`claude-bugfix.yml:36,40`).

**Failure scenario:**
1. An attacker self-registers (`POST /api/auth/register`) and `POST /api/client-errors` with a crafted
   `name`/`message`/`componentStack` (capped but ~6 KB of free text) containing prompt-injection —
   e.g. text that closes the prompt's context block and issues new "instructions" to add a backdoor or
   exfiltrate `ANTHROPIC_API_KEY`/the `GITHUB_TOKEN`. The row is stored as `kind='crash'`
   (`db.createCrash`, severity `high`).
2. A superuser triaging the admin Bugs surface clicks "🤖 Claude" on that high-severity crash — a
   normal triage action. `claude-fix` dispatches the attacker's `text`/`context` verbatim.
3. The workflow interpolates it into the Claude agent, which runs with repo write + a secret. Even
   though output is PR-only (human merges), the agent can push branches, craft a disguised-backdoor PR,
   or attempt secret exfiltration during the run.

The QR-channel note aside, the pipeline's own comment says it "NEVER pushes to main … a human merges"
— true, but that guards *deploy*, not *the agent being hijacked mid-run by untrusted input*.

**Adversarial verification:** could the crash content be considered trusted? No — `POST
/api/client-errors` is `requireAuth` only (any active account, self-serve registration), and every
field it stores comes from `req.body`/headers. Could React escaping or the human-merge gate already
neutralize it? Those defend *stored-XSS* and *deploy*, not *prompt-injection into a running CI agent
with a live token*. The finding survives.

**Fix (this PR — two layers, function-preserving for the intended super-authored case):**
1. **Server trust gate** (`server/lib/bugfix_gate.js` + `index.js`): `claude-fix` refuses any bug whose
   `kind` is not superuser-authored (`bug`/`feature`/`change`). `crash` — the only user-plantable kind —
   is rejected with a clear Russian message, severing the plant path. A super can still act on a crash
   by filing a normal bug in their own (trusted) words.
2. **Defense-in-depth sanitization + workflow fence:** `sanitizeForPrompt()` strips ASCII control
   chars, defangs role headers (`System:`/`User:`…) and neutralizes the fence marker before dispatch;
   the workflow wraps `text`/`context` in `UNTRUSTED-BUG-REPORT` markers with a guardrail preamble
   instructing the agent to treat them as data, never instructions, and to exfiltrate nothing. This
   protects even allowed-kind bugs that quote user text.

**Regression:** `test/bugfix_gate.test.js` — crash never dispatchable; fence-breakout / role-header /
control-char neutralization; length cap. `npm run check` green (21 pass).

**Residual (recommendations, not shipped):** consider dropping `issues: write` (S3); consider scoping
the pipeline so the agent's shell cannot read `ANTHROPIC_API_KEY` (verify claude-code-action's env
exposure); the human reviewer remains the last line of defense — review auto-fix PRs adversarially.

### S2 — `INGEST_TOKEN` query-param fallback (Low)
`POST /api/ingest/daily` accepts the token as `?token=` when the `x-ingest-token` header is absent
(`index.js:2500`). Compared timing-safely and a deprecation warning is logged, and the shipped cron
(`ingest.yml:22`) uses the header — but a token in a URL can land in edge/proxy access logs. The app
itself logs `req.path` (no query string) so it doesn't self-leak. **Recommend** removing the query
fallback once no external cron relies on it. Verdict: resilient-with-caveat.

### S3 — `claude-bugfix.yml` least-privilege (Info)
The job grants `issues: write` but the prompt only opens a PR. Drop it unless `claude-code-action`
needs it (verify before removing to avoid breaking the pipeline).

---

## 3. Role × endpoint authorization matrix

Principals: **anon** · **user** (active account) · **member/admin/owner** (workspace roles) ·
**super** (superuser) · **api-key** (collector) · **ingest-token** (cron) · **internal-token**
(web→mtproto) · **dispatch-token** (web→GitHub).

| Surface | Principal required | Gate (file:line) |
|---|---|---|
| `POST /api/auth/*` (register/login/google/verify/forgot/reset/resend) | anon + `authLimiter` | anti-enumeration, single-use tokens (`index.js:387-621`) |
| `GET /api/config`, `/api/health`, `/api/ready` | anon | no secrets |
| `GET/PUT /api/prefs`, `/api/me/*`, `change-password` | user (uid-scoped) | `requireAuth` (`index.js:625-656`) |
| `GET /api/channels`, tenant TG/IG/history/report reads | member+ of channel | `requireAuth`+`resolveChannel`/`getChannel` (Task-1 matrix) |
| annotations write · keys · IG connect/disconnect | member / admin | `requireWorkspaceRole` (`middleware/tenant.js:44`) |
| `POST/GET/PATCH/DELETE /api/bugs*`, `bug-attachment`, `cache` | **super** | `requireSuper` (`index.js:246`) |
| **`POST /api/bugs/:id/claude-fix`** | **super** + kind∈{bug,feature,change} | `requireSuper` + `canDispatchBugKind` (**S1 fix**) |
| `POST /api/client-errors` | user (own crash; uid hashed) | `requireAuth`+`crashLimiter` (`index.js:2650`) |
| `PATCH /api/admin/users/:id` | super (+ self-lockout guard) | `requireSuper` (`index.js:665`) |
| `POST /api/collector/ingest` | api-key (its own channel; central rejected) | `requireApiKey` (`routes/collector.js:78`) |
| `POST /api/ingest/daily` | ingest-token (timing-safe) | `INGEST_TOKEN` (`index.js:2501`) |
| all `mtproto/service.py` data routes | internal-token (fail-closed) | `check_auth` (`service.py:111`) |
| `repository_dispatch → claude-bugfix` | dispatch-token; PR-only | `GITHUB_DISPATCH_TOKEN`, `contents/PR write`, human merge |

---

## 4. Explicit verdict per threat scenario (card §"Threat / failure scenarios")

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 1 | Cross-tenant read/write (ADR-001) | **Resilient** (1 leak fixed) | Every path via `getChannel`/`resolveChannel`; `hasWorkspaceRole` DB-off branch only fires when `channel.id==null` (dev, DB off) — never in prod (`tenant.js:39`). Shared-source read leak = **F1, fixed PR #56**. |
| 2 | IG env-fallback as leak channel | **Resilient** | env account gated to `!db.enabled \|\| role==='superuser'` (`index.js:793`); `ig_tags` archive served only for `source==='env'`, per-channel connections serve live-only → no cross-channel tag leak (`index.js:874`). |
| 3 | Collector ingest forged token / idempotency abuse | **Resilient** | 192-bit `pa_` keys, sha256 at rest, RL 60/15m; `ingest_id`+`payload_hash`→`INGEST_ID_CONFLICT` (409); `channel_id` from key not body; `sanitizeJson` blocks `__proto__`/`prototype`/`constructor`, caps rows/bytes/depth (`contract.js:42-69`). |
| 4 | **Prompt-injection in Claude pipeline** | **VULNERABLE → fixed (S1)** | crash content (any user) → write-capable agent. Gate + fence shipped. |
| 5 | Stateless token & revocation | **Resilient** | HMAC-SHA256 `timingSafeEqual` (`auth.js:29`); `token_version` checked every request (`index.js:226`); sliding re-issue is an *idle* window (exp still enforced, `auth.js:88`); prod `process.exit(1)` without `SESSION_SECRET`; domain-separated `IG_STATE_KEY`/`IP_HASH_KEY`. |
| 6 | MTProto session security | **Resilient** | `check_auth` fail-closed `compare_digest` (`service.py:111`); QR id→uid bound web-side (`_qrOwns`); StringSession read from body, **never logged** (`service.py:1276`); AES-256-GCM at rest. "Not re-verify admin" on `qr/channels` = write is owner-scoped; the read vector was F1 (fixed). |
| 7 | Secrets | **Resilient + 1 Low** | `MTPROTO_TOKEN`/`SESSION_SECRET` required in prod; AES-GCM key handling (`ig_crypto`/`tg_crypto`); `err.stack` logged server-side only, client gets generic 500 (`index.js` error mw); `DATABASE_URL` SSL smart-default. **S2**: `?token=` fallback (Low). |
| 8 | CSP/nonce & XSS | **Resilient** | nonce shell (no `unsafe-inline` scripts) + SPA CSP; `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`; `/api/auth/verify` embeds the token via `JSON.stringify(...).replace(/</,'\\u003c')` (`index.js:542`); `ALLOWED_IMG` raster-only + magic-byte `sniffImage` blocks SVG stored-XSS. |
| 9 | CSRF | **Resilient** | auth is a custom `x-session-token` **header** (not a cookie) → cross-site forms can't attach it; CORS defaults closed; `ig/oauth/callback` trusts a signed+expiring state; `auth/verify` POST consumes a single-use token. |
| 10 | Rate-limit bypass | **Resilient** | `trust proxy: 2` (fixed hop count, not `true`); per-uid key from the **signed** token (unforgeable, can't poison another bucket); XFF spoof ignored beyond trusted hops; anon → per-IP (`auth.js:80`, `index.js:29`). |
| 11 | Open media proxies (SSRF/enum) | **Resilient / by-design (F2)** | `thumb/:id`+`channel/photo` resolve only against the configured **public central** channel (`service.py:801,845`); `msg_id` is an int, no arbitrary URL; `mediaLimiter` bounds scraping. Revisit with signed URLs before any private channel is proxied. |
| 12 | Supply-chain / migrations / jobs | **Resilient** | `pg_advisory_lock` serializes; each migration in its own `BEGIN/COMMIT`, failure → `ROLLBACK`+throw (no partial schema); zero-padded 3-digit prefixes → lexicographic == numeric order (009<010<011); `runJobOnce` claim/lease dedups a second instance (`db.js:1440`). **S3**: drop `issues: write`. Dep surface small (express, pg, express-rate-limit, node-fetch, cors, dotenv); Telethon ≥1.43.2 required (CLAUDE.md). |

---

## 5. Deliverables & status
- This document (STRIDE model + findings table + role×endpoint matrix + 12 verdicts).
- **Fix PR** (branch `claude/security-stride-audit`): S1 server gate (`server/lib/bugfix_gate.js`,
  `server/index.js`) + workflow fence (`.github/workflows/claude-bugfix.yml`) + regression
  (`test/bugfix_gate.test.js`). `npm run check` green.
- **Open items for the human:** ratify the S1 gate (crash → no auto-fix); decide S2 query-token
  removal and S3 `issues: write` drop; consider verifying claude-code-action secret-env exposure.
- **Cross-references:** F1 (shared-source read leak) fixed in PR #56; that PR's tenancy matrix is the
  companion to §3 here.
