// ═══════════════════════════════════════════════════════════════
//  Atlavue — Backend Server
//  Node.js + Express
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const db         = require('./db');
const { createAuth, hashPassword, verifyPassword, SCRYPT, rateLimitKey, isSessionStale } = require('./lib/auth');
const { captionSnippet } = require('./lib/caption');
const { fetchWithTimeout } = require('./lib/http');
const { MTPROTO_TOKEN, MTPROTO_TIMEOUT_HEAVY_MS, mtprotoFetch, mtprotoPost } = require('./lib/mtproto-client');
const { log, requestContext, hashIp } = require('./lib/observability');
const { legacyCspHeader, setAppHeaders, setHtmlSecurityHeaders } = require('./lib/securityHeaders');
const { makeResolveChannel, hasWorkspaceRole } = require('./middleware/tenant');
const { registerCollectorRoutes } = require('./routes/collector');
const { registerAuthRoutes } = require('./routes/auth');
const { registerReportsRoutes } = require('./routes/reports');
const { registerBugsRoutes } = require('./routes/bugs');
const { registerChannelsRoutes } = require('./routes/channels');
const { registerTgRoutes } = require('./routes/tg');
const { registerIgOauthRoutes } = require('./routes/ig-oauth');

const app  = express();
const PORT = process.env.PORT || 3000;
// Railway forwarding chain (confirmed via the proxy diagnostic): the app's socket
// peer is Railway's internal LB (100.64.0.0/10) and X-Forwarded-For = "client, edge".
// So the address list (socket → outward) is [LB, edge, client] and we must trust 2
// hops to land on the real client IP. `trust proxy: 1` returned the shared edge IP
// (152.x) for everyone → a global rate-limit bucket. NOT `true` (that trusts client-
// supplied XFF and is spoofable); the fixed count 2 ignores any prefixed fake hops.
app.set('trust proxy', 2);

// История (Postgres) — поднимаем схему, если БД подключена; иначе тихо выключено.
// После схемы — бутстрап админ-аккаунта, затем привязка central-канала к админу.
// dbReady гейтит data-роуты, пока идёт миграция (app.listen стартует синхронно).
let dbReady = false;
db.init().then(bootstrapAdmin).then(claimOwnerChannel).then(() => { dbReady = true; })
  .catch(e => { log('error', 'db_init_failed', { error: e.message }); dbReady = false; });

// ── Middleware ───────────────────────────────────────────────────
// CORS: дашборд обслуживается тем же origin (Express отдаёт и статику, и API),
// поэтому кросс-доменный доступ по умолчанию не нужен → не отдаём wildcard ACAO.
// Для будущих внешних API-клиентов origin'ы можно явно разрешить через
// CORS_ORIGINS (список через запятую).
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : false, credentials: false }));
app.use(requestContext);
// A rejected promise in an async route otherwise escapes Express 4 entirely and
// kills the process (unhandled rejection). Wrap handlers whose awaits are not fully
// inside try/catch; the terminal error middleware (registered last) does the rest.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// JSON body parser — default 100kb. Big-body routes (collector ingest, bug
// screenshots, avatar upload) carry their own higher-limit parser, so skip them
// here; otherwise this 100kb parser would reject their large payloads before the
// route is reached (body-parser no-ops on an already-parsed body, so the
// route-local limit would never apply).
const jsonSmall = express.json();
app.use((req, res, next) => {
  if (req.path === '/api/collector/ingest'
    || req.path === '/api/me/avatar'   // own 1mb parser — a 100KB-400KB data URL is a valid avatar
    || /\/screenshot$/.test(req.path)) return next();
  jsonSmall(req, res, next);
});
// ── App shell + strict nonce-CSP ──────────────────────────────────
// index.html is the only HTML surface that renders collector-snapshot data.
// A per-request nonce on its inline <script> tags + `script-src 'nonce-…'`
// (no 'unsafe-inline') means an injected <script> or inline event handler can't
// execute — closes the snapshot self-XSS class (defence-in-depth on top of the
// server-side escape/Number coercion). Inline styles stay allowed (style
// injection isn't code execution); only Google Fonts is external.
const APP_HTML_PATH = path.join(__dirname, '../public/index.html');
let APP_HTML = '';
try { APP_HTML = fs.readFileSync(APP_HTML_PATH, 'utf8'); }
catch (e) { console.error('[csp] index.html read failed:', e.message); }
function sendApp(req, res) {
  const nonce = crypto.randomBytes(16).toString('base64');
  let src = APP_HTML;
  if (!src) { try { src = fs.readFileSync(APP_HTML_PATH, 'utf8'); } catch { return res.status(500).end(); } }
  const html = src.split('<script>').join(`<script nonce="${nonce}">`);
  setHtmlSecurityHeaders(req, res, legacyCspHeader(nonce))
     .set('Content-Type', 'text/html; charset=utf-8')
     .send(html);
}
// 3F-3 catover: '/' now serves the new Vite/React SPA (wired in the tail below). The
// legacy nonce-shell is reachable at /legacy as a reversible escape hatch until B2
// cleanup. Only its /js asset is still served from public/ (public/index.html is no
// longer routed — the SPA fallback owns '/').
app.use('/js', express.static(path.join(__dirname, '../public/js')));

// General read limiter for the authed dashboard (~9 reads per refresh). Keyed PER
// USER, not per IP: behind Railway's proxy `trust proxy: 1` can resolve req.ip to a
// shared upstream address, so an IP-keyed limit would be effectively global — one
// user (or an external probe hitting /api/health etc.) could throttle everyone,
// surfacing as "Источники недоступны" and login "Слишком много запросов". A signed
// session token can't be forged and parseToken (defined below) rejects garbage, so
// keying by uid is safe and token-rotation can't escape it; unauthenticated requests
// fall back to a per-IP bucket. 600/15min is generous for real dashboard usage.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  keyGenerator: (req) => rateLimitKey(parseToken(req.headers['x-session-token']), req.ip),
  message: { error: 'Слишком много запросов. Попробуй через 15 минут.' }
});
app.use('/api/', limiter);

// Stricter limiter for auth endpoints (brute-force / enumeration hardening).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Слишком много попыток входа. Подожди 15 минут.' }
});

// ── Авторизация: stateless HMAC-токены (переживают рестарт/редеплой) ──
// Token signing secret: a dedicated SESSION_SECRET and nothing else. There is no
// fallback — a shared login password must never double as the session-forgery key.
// Production refuses to boot without the required secrets (an ephemeral secret
// would silently log everyone out on each deploy); dev gets a random per-process
// secret with a warning.
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
  || !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
{
  const missing = [];
  if (!process.env.SESSION_SECRET) {
    missing.push(
      'SESSION_SECRET is not set. It signs dashboard session tokens.',
      '    → Set SESSION_SECRET to a long random value (e.g. `openssl rand -hex 32`).',
      '      Rotating it invalidates every active session.');
  }
  if (process.env.MTPROTO_URL && !process.env.MTPROTO_TOKEN) {
    missing.push(
      'MTPROTO_TOKEN is not set, but MTPROTO_URL is configured.',
      '    → Set MTPROTO_TOKEN to a long random value (e.g. `openssl rand -hex 32`)',
      '      and set the SAME value on the mtproto service — it authenticates the',
      '      internal web → mtproto calls (x-internal-token header).');
  }
  if (missing.length && IS_PRODUCTION) {
    console.error([
      '════════════════════════════════════════════════════════════════════',
      '[boot] FATAL: required secrets are missing in a production environment.',
      ...missing.map(l => '[boot] ' + l),
      '[boot] (The legacy shared team-password env is no longer read — delete it',
      '[boot]  from both services once SESSION_SECRET/MTPROTO_TOKEN are set.)',
      '════════════════════════════════════════════════════════════════════',
    ].join('\n'));
    process.exit(1);
  }
}
const AUTH_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET not set (dev) — using an ephemeral random secret; sessions will not survive a restart');
}
// Domain-separated subkeys derived from AUTH_SECRET — the raw session-signing
// secret is never reused directly for other HMAC purposes.
// (The OAuth-state signing subkey ('ig-state') is derived in routes/ig-oauth.js from the injected
// AUTH_SECRET, alongside the sign/parse helpers that are its only consumers.)
const IP_HASH_KEY  = crypto.createHmac('sha256', AUTH_SECRET).update('ip-hash').digest();

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').toLowerCase().trim();
// Idle window: an active user is kept signed in by a sliding re-issue (see requireAuth) so this is
// the MAX time between requests before a re-login is required, not a hard cap on a live session.
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const auth = createAuth({ secret: AUTH_SECRET });
const signSession = auth.signSession;
const parseToken = auth.parseToken;
// "Sign in with Google" (Google Identity Services). The client id is public — it's both the GSI
// button's client_id AND the audience we verify the returned ID token against. No client secret is
// needed for the ID-token flow. Unset → the feature is inert (frontend hides the button).
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

async function audit(req, action, metadata = {}) {
  if (!db.enabled) return false;
  return db.recordAuditEvent({
    uid: req.user && req.user.uid != null ? req.user.uid : null,
    channel_id: req.channel && req.channel.id != null ? req.channel.id : null,
    action,
    request_id: req.requestId,
    ip_hash: hashIp(req.ip, IP_HASH_KEY),
    metadata,
  });
}

// Optional bootstrap: create the ADMIN_EMAIL account as an active superuser at startup
// (needs ADMIN_PASSWORD). Removes the register-time race for the admin email.
async function bootstrapAdmin() {
  if (!db.enabled || !ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
  try {
    if (!(await db.getUserByEmail(ADMIN_EMAIL))) {
      await db.createUser({ email: ADMIN_EMAIL, pass_hash: hashPassword(process.env.ADMIN_PASSWORD), role: 'superuser', status: 'active' });
      console.log('[auth] bootstrapped admin account:', ADMIN_EMAIL);
    }
  } catch (e) { console.error('[auth] admin bootstrap failed:', e.message); }
}

// Claim the orphan central channel for the admin once its account exists (the
// owner channel may be created with owner_uid NULL at first boot if the admin
// row isn't there yet). Idempotent — no-op once owned.
async function claimOwnerChannel() {
  if (!db.enabled || !ADMIN_EMAIL) return;
  try {
    const u = await db.getUserByEmail(ADMIN_EMAIL);
    if (u) await db.adoptOwnerChannel(u.id);
  } catch (e) { console.error('[db] adopt owner channel failed:', e.message); }
}

// Auth: validates the token, then re-checks the user is still active (so role
// changes / disable take effect immediately, not only on next login). Every valid
// session carries a numeric uid (parseToken rejects anything else), so req.user
// always maps to a real users row.
async function requireAuth(req, res, next) {
  const sess = parseToken(req.headers['x-session-token']);
  if (!sess) return res.status(401).json({ error: 'Сессия истекла, войди снова' });
  req.session = sess;
  try {
    const u = await db.getUserById(sess.uid);
    if (!u || u.status !== 'active') return res.status(401).json({ error: 'Аккаунт неактивен — войди снова' });
    if (sess.tokenVersion !== u.token_version) {
      return res.status(401).json({ error: 'Сессия отозвана — войди снова' });
    }
    req.user = { uid: u.id, role: u.role, email: u.email };
    // Sliding session: once the token is past its half-life, hand back a fresh one on the response so
    // an ACTIVE user is never logged out mid-work; the client persists it (see api/client.ts). Idle
    // longer than SESSION_TTL still lets the token die (parseToken rejects an expired exp), so this is
    // a sliding idle window, not an immortal session. token_version revocation is unaffected — a fresh
    // token carries the current version, so a bumped version still invalidates it on the next request.
    const now = Date.now();
    if (isSessionStale(sess.exp, now, SESSION_TTL)) {
      const fresh = signSession({ uid: u.id, role: u.role, exp: now + SESSION_TTL, tokenVersion: u.token_version });
      res.set('X-Session-Refresh', fresh);
      res.set('Cache-Control', 'no-store'); // a response carrying a token must never be shared-cached
    }
    next();
  } catch (e) { next(e); }
}

function requireSuper(req, res, next) {
  if (!req.user || req.user.role !== 'superuser') return res.status(403).json({ error: 'Доступ только для администратора' });
  next();
}

// ── Channel (tenant) resolution & isolation ──────────────────────
const resolveChannel = makeResolveChannel({ db, isReady: () => dbReady });

// ── In-memory кэш ───────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry || entry.expires < Date.now()) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data, ttl = CACHE_TTL) {
  // Bounded: the key space (per-channel × per-param) is otherwise unbounded and
  // grows into a slow memory leak. Evict the oldest entry (insertion order ≈ age).
  if (!cache.has(key) && cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { data, expires: Date.now() + ttl });
}
// Expired entries used to be reaped only on re-read, so one-off keys lingered for
// the process lifetime. unref(): the sweep must not hold the process open (tests).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expires < now) cache.delete(key);
}, 60 * 1000).unref();

// Clamp a user-supplied numeric option to the nearest allowed value BEFORE it becomes
// a cache key — otherwise every distinct value is its own cache miss and a fresh
// burst of upstream (Graph) calls.
const nearestOf = (value, allowed) =>
  allowed.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best));

// ── Email (verification / password reset) via Resend — no new dependency ──
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Atlavue <onboarding@resend.dev>';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
// Canonical public origin (Atlavue rebrand) — last-resort fallback for emailed
// links / OAuth callbacks when APP_URL is unset and the request Host isn't
// allow-listed. Constant, not the old Railway host: a stale fallback silently
// mints links to a domain we no longer present to users.
const CANONICAL_ORIGIN = 'https://atlavue.app';
// Hosts honoured from the request when APP_URL isn't set — defends emailed links
// against Host-header poisoning (reset link → account takeover). Best practice:
// set APP_URL in production. Override the allowlist with TRUSTED_HOSTS (comma-sep).
const TRUSTED_HOSTS = new Set(
  (process.env.TRUSTED_HOSTS || new URL(CANONICAL_ORIGIN).host)
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
// In production an unset APP_URL silently falls back to CANONICAL_ORIGIN —
// emailed verify/reset links and the IG OAuth callback then point at the
// hardcoded default rather than the configured domain. Loud boot error,
// deliberately NON-FATAL: a missing env var must not crash-loop prod — the
// dashboard itself still works without it.
if (!APP_URL && IS_PRODUCTION) {
  console.error([
    '════════════════════════════════════════════════════════════════════',
    '[boot] APP_URL is not set in a production environment!',
    '[boot] Emailed verification/reset links and the Instagram OAuth callback',
    `[boot] will fall back to "${CANONICAL_ORIGIN}".`,
    `[boot] Set APP_URL to the canonical public origin, e.g. ${CANONICAL_ORIGIN}`,
    '════════════════════════════════════════════════════════════════════',
  ].join('\n'));
}
const VERIFY_TTL = 24 * 60 * 60 * 1000;
const RESET_TTL  = 60 * 60 * 1000;
const sha256   = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// Constant-time secret compare. Raw `!==` leaks length/prefix timing; timingSafeEqual
// throws on length mismatch — comparing fixed-length digests avoids both.
const timingSafeEqualStr = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest());
const newToken = () => crypto.randomBytes(32).toString('base64url');
const escHtml  = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
// Public origin for emailed links. NEVER trust a raw Host header (poisonable):
// use APP_URL, else only an allow-listed / localhost host, else the canonical default.
function appBase(req) {
  if (APP_URL) return APP_URL;
  const host = String((req && req.get && req.get('host')) || '').toLowerCase();
  if (TRUSTED_HOSTS.has(host)) return 'https://' + host;                        // prod → https (never reflect X-Forwarded-Proto)
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return 'http://' + host;  // local dev
  return CANONICAL_ORIGIN;                                                      // untrusted host → canonical default
}
// Fixed-cost hash so login spends scrypt time even when the email doesn't exist
// (kills the "skip the hash on missing user" enumeration timing oracle).
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${'0'.repeat(32)}$${'0'.repeat(128)}`;

// Send via Resend (plain fetch). No key → log only non-secret metadata; in DEV
// additionally log the action link (`devLink`) so registration/reset flows are
// completable locally without an email provider — production never prints it.
// Never throws (auth flows stay generic on email failure).
async function sendEmail(to, subject, html, devLink) {
  if (!RESEND_API_KEY) {
    console.log(`[email:dev] to=${to} · "${subject}" (RESEND_API_KEY unset — not sent)`);
    if (!IS_PRODUCTION && devLink) console.log(`[email:dev] action link: ${devLink}`);
    return true;
  }
  try {
    const r = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
    });
    if (!r.ok) { console.error('[email] resend', r.status, (await r.text().catch(() => '')).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error('[email] send error:', e.message); return false; }
}
const emailShell = (title, body) =>
  `<div style="font-family:system-ui,Segoe UI,sans-serif;max-width:480px;color:#061b31"><h2 style="font-weight:600">${title}</h2>${body}</div>`;
const emailBtn = (href, label) =>
  `<p><a href="${escHtml(href)}" style="display:inline-block;padding:10px 18px;background:#533afd;color:#fff;border-radius:6px;text-decoration:none">${label}</a></p>`;

// Auth/account entrypoints are isolated in their own route module; session
// validation middleware stays here because many non-auth domains share it.
registerAuthRoutes({
  app,
  express,
  db,
  requireAuth,
  authLimiter,
  asyncHandler,
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  signSession,
  SESSION_TTL,
  GOOGLE_CLIENT_ID,
  fetchWithTimeout,
  log,
  audit,
  appBase,
  sha256,
  newToken,
  VERIFY_TTL,
  RESET_TTL,
  sendEmail,
  emailShell,
  emailBtn,
  escHtml,
});

// Public runtime config for the SPA (no secrets). Currently just the Google client id so the login
// UI can decide whether to show the "Sign in with Google" button.
app.get('/api/config', (req, res) => {
  res.json({ google_client_id: GOOGLE_CLIENT_ID || null });
});

app.get('/api/auth/check', requireAuth, (req, res) => {
  res.json({ ok: true, role: req.user.role, email: req.user.email });
});

// ── Персональная раскладка дашборда (порядок/скрытие/ширина блоков) ──
// Режим без БД → null / stored:false: клиент сам хранит раскладку в localStorage.
app.get('/api/prefs', requireAuth, async (req, res, next) => {
  try { res.json({ prefs: await db.getPrefs(req.user.uid) }); }
  catch (e) { next(e); }
});

app.put('/api/prefs', requireAuth, async (req, res, next) => {
  const prefs = req.body && req.body.prefs;
  if (prefs == null || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return res.status(400).json({ error: 'prefs должен быть объектом' });
  }
  // The blob carries dashboard layout AND the metric-builder widget configs (WidgetConfig[]), so it
  // needs more room than the original layout-only 8 KB — 32 KB is still a tight bound per user.
  if (JSON.stringify(prefs).length > 32000) {
    return res.status(413).json({ error: 'prefs слишком большой' });
  }
  try { const stored = await db.setPrefs(req.user.uid, prefs); res.json({ ok: true, stored: !!stored }); }
  catch (e) { next(e); }
});

// ── Admin: user management (superuser only) ──
app.get('/api/admin/users', requireAuth, requireSuper, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  try {
    res.json({ users: await db.listUsers(), roles: db.USER_ROLES, statuses: db.USER_STATUSES, me: req.user.uid });
  } catch (e) { next(e); }
});

app.patch('/api/admin/users/:id', requireAuth, requireSuper, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  // don't let an admin lock themselves out
  if (req.user.uid === id && (req.body.role === 'user' || req.body.status === 'disabled')) {
    return res.status(400).json({ error: 'Нельзя понизить или отключить собственный аккаунт' });
  }
  try {
    const before = await db.getUserById(id);
    const u = await db.updateUser(id, { role: req.body.role, status: req.body.status });
    if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
    audit(req, 'admin.user_updated', {
      target_uid: id,
      before: before ? { role: before.role, status: before.status } : null,
      after: { role: u.role, status: u.status },
    }).catch(() => {});
    res.json(u);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Admin-стирание аккаунта (GDPR F4, второй путь). Суперюзеров панель не удаляет — владелец
// стирается только вручную с сервера (иначе одна кнопка оставляет приложение без админа).
app.delete('/api/admin/users/:id', requireAuth, requireSuper, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const target = await db.getUserById(id);
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.role === 'superuser') return res.status(400).json({ error: 'Суперюзера нельзя удалить из панели' });
    const ok = await db.deleteUserAccount(id);
    // Аудит ПОСЛЕ успеха (uid записи = админ, он жив): провал не оставляет ложного «deleted».
    // target_uid — номер-надгробие без идентифицирующих данных.
    if (ok) await audit(req, 'admin.user_deleted', { target_uid: id }).catch(() => {});
    res.json({ ok });
  } catch (e) { next(e); }
});

// ── GDPR: собственный аккаунт — экспорт (F5) и стирание (F4) ──

// Обе операции тяжёлые/необратимые и уже за requireAuth — лимитер здесь щит от абьюза
// украденным токеном (bulk-экспорт, brute «угадай email» на DELETE), не от юзера.
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Слишком много запросов к данным аккаунта. Подожди 15 минут.' },
});

// Все персональные данные одним JSON-файлом (архивы каналов включены; credentials —
// pass_hash / TG-сессия / IG-токен — не покидают сервер никогда, см. db.exportUserData).
app.get('/api/account/export', accountLimiter, requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  try {
    const data = await db.exportUserData(req.user.uid);
    if (!data) return res.status(404).json({ error: 'Пользователь не найден' });
    audit(req, 'account.exported', {}).catch(() => {});
    // Самый чувствительный ответ приложения — никакому кэшу его не хранить.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition',
      `attachment; filename="atlavue-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(data);
  } catch (e) { next(e); }
});

// Немедленный hard-delete (решение владельца: без grace-периода — восстановление это просто
// переподключение источников). Подтверждение — точный email аккаунта: пароль здесь не работает
// как фактор (Google-аккаунты живут с неиспользуемым случайным pass_hash). Каскадную полноту
// и судьбу общих данных описывает db.deleteUserAccount.
app.delete('/api/account', accountLimiter, requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  if (req.user.role === 'superuser') {
    return res.status(403).json({ error: 'Аккаунт суперюзера удаляется только вручную с сервера' });
  }
  const confirm = String((req.body && req.body.confirm) || '').trim().toLowerCase();
  if (!confirm || confirm !== String(req.user.email || '').toLowerCase()) {
    return res.status(400).json({ error: 'Введите email аккаунта для подтверждения' });
  }
  try {
    // Аудит до удаления (после — FK на несуществующий uid). Action-имя честное: это фиксация
    // ЗАПРОСА; сама строка при успехе тут же анонимизируется внутри deleteUserAccount.
    // Metadata пустые — email в журнале сделал бы стирание неполным.
    await audit(req, 'account.delete_requested', {}).catch(() => {});
    // Прощальное письмо ДО удаления (адрес вот-вот исчезнет). Это и уведомление о
    // destructive-действии: если аккаунт стёр вор с украденным токеном — владелец узнаёт.
    await sendEmail(req.user.email, 'Аккаунт удалён — Atlavue', emailShell('Аккаунт удалён',
      '<p>Ваш аккаунт Atlavue и все связанные данные (каналы, архивы, отчёты, подключения) ' +
      'только что безвозвратно удалены по запросу из настроек.</p>' +
      '<p style="color:#64748d;font-size:13px">Если это были не вы — ответьте на это письмо немедленно: ' +
      'остаточные копии в резервных бэкапах существуют ещё до 30 дней.</p>')).catch(() => {});
    const ok = await db.deleteUserAccount(req.user.uid);
    if (!ok) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ════════════════════════════════════════════════════════════════
//  INSTAGRAM ROUTES
// ════════════════════════════════════════════════════════════════

// "Instagram API with Instagram Login" (no Facebook Page): the IG user access token works
// against graph.instagram.com, NOT graph.facebook.com. IG_ACCESS_TOKEN/IG_ACCOUNT_ID is the
// global single-account fallback; per-channel OAuth tokens (ig_accounts) layer on top and take
// precedence when a channel has connected its own account (see resolveIg below).
const IG_BASE      = 'https://graph.instagram.com/v22.0';   // versioned data edges
const IG_GRAPH     = 'https://graph.instagram.com';         // token exchange / refresh / me (unversioned)
const IG_TOKEN     = process.env.IG_ACCESS_TOKEN;
const IG_ACCOUNT   = process.env.IG_ACCOUNT_ID;
const igCrypto     = require('./lib/ig_crypto');
const tgCrypto     = require('./lib/tg_crypto');
const igMock       = require('./ig_mock');
// Global env single-account is "configured" when both token + account id are present.
// (The per-channel OAuth connect flow + its app credentials live in routes/ig-oauth.js.)
const igConfigured = () => !!IG_TOKEN && !!IG_ACCOUNT;

// Single choke-point for all Graph data calls. `token` defaults to the global env token so any
// legacy caller keeps working; the IG routes pass the per-request token (req.ig.token).
// Singleflight: concurrent identical calls (two tabs, a dashboard fan-out racing the cache)
// share ONE Graph request instead of multiplying quota burn. Keyed by the full URL — the
// access token is part of it, so different accounts never share a flight.
const igInflight = new Map();
function igFetch(path, params = {}, token = IG_TOKEN) {
  params.access_token = token;
  const qs  = new URLSearchParams(params).toString();
  const url = `${IG_BASE}${path}?${qs}`;
  let flight = igInflight.get(url);
  if (!flight) {
    flight = (async () => {
      const res = await fetchWithTimeout(url);
      const json = await res.json();
      if (json.error) {
        const err = new Error(`Instagram API: ${json.error.message}`);
        err.status = 502;   // upstream failure — message is safe to surface to the dashboard
        throw err;
      }
      return json;
    })();
    igInflight.set(url, flight);
    // side chain only clears the map; swallow its rejection (callers hold the original promise)
    flight.finally(() => igInflight.delete(url)).catch(() => {});
  }
  return flight;
}

// Long-lived IG tokens live ~60 days and can be refreshed once ≥24h old. Refresh opportunistically
// on read when within 10 days of expiry (and not already dead): the fresh 60-day token is
// re-encrypted and persisted. Any failure is swallowed — the current token is returned so the
// request never breaks; a truly-expired token surfaces as a Graph error → reconnect needed.
const IG_REFRESH_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
async function refreshIgIfNeeded(channelId, token, expiresAtStr) {
  try {
    if (!expiresAtStr) return token;
    const exp = new Date(expiresAtStr).getTime();
    if (!Number.isFinite(exp)) return token;
    const now = Date.now();
    if (exp <= now || exp - now > IG_REFRESH_WINDOW_MS) return token;   // dead, or not due yet
    const r = await fetchWithTimeout(`${IG_GRAPH}/refresh_access_token?` + new URLSearchParams({
      grant_type: 'ig_refresh_token', access_token: token }).toString());
    const j = await r.json();
    if (j && j.access_token && j.expires_in) {
      await db.updateIgToken(channelId, igCrypto.encrypt(j.access_token), new Date(now + j.expires_in * 1000)).catch(() => {});
      return j.access_token;
    }
  } catch (e) { log('warn', 'ig_token_refresh_failed', { channelId, error: e.message }); }
  return token;
}

// Per-request IG identity: resolve { accountId, token, source } for THIS request's channel.
// Priority: (1) the channel's own OAuth token from ig_accounts (decrypted + refreshed);
// (2) the global env single-account token; (3) null → the route serves mock. Unlike
// resolveChannel it never short-circuits on a missing channel and never 500s on a decrypt
// failure — the IG UI must always render (real, env-fallback, or mock). Requires requireAuth
// upstream (uses req.user for the channel ownership check).
async function resolveIg(req, res, next) {
  req.ig = null;
  try {
    const channelId = parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
    if (db.enabled && channelId && igCrypto.configured()) {
      const ch  = await db.getChannel(channelId, req.user).catch(() => null);
      const acc = ch ? await db.getIgAccount(channelId).catch(() => null) : null;
      if (acc && acc.access_token_enc) {
        try {
          let token = igCrypto.decrypt(acc.access_token_enc);
          token = await refreshIgIfNeeded(channelId, token, acc.token_expires_at);
          req.ig = { accountId: acc.ig_user_id, token, source: 'channel', channelId, username: acc.username };
        } catch (e) {
          log('warn', 'ig_token_decrypt_failed', { channelId, error: e.message });   // fall through to env/mock
        }
      }
    }
    // Env single-account fallback = the superuser's own account (@bynotem via IG_ACCESS_TOKEN). Gate
    // it to the superuser (or local dev with no DB): a regular user requesting a channel they don't
    // own must NOT be served the env account's real data — they get mock (the connect prompt). This
    // closes the X-Channel-Id spoof where getChannel() denies but the code fell through to env.
    if (!req.ig && igConfigured() && (!db.enabled || (req.user && req.user.role === 'superuser'))) {
      req.ig = { accountId: IG_ACCOUNT, token: IG_TOKEN, source: 'env', channelId: null };
    }
  } catch (e) {
    log('warn', 'resolve_ig_failed', { error: e.message });
  }
  next();
}

// GET /api/ig/profile — профиль аккаунта (теперь с аватаркой)
app.get('/api/ig/profile', requireAuth, resolveIg, async (req, res, next) => {
  try {
    if (!req.ig) return res.json(igMock.igMockProfile());
    const cacheKey = `ig:profile:${req.ig.accountId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await igFetch(`/${req.ig.accountId}`, {
      fields: 'username,name,followers_count,follows_count,media_count,biography,website,profile_picture_url'
    }, req.ig.token);
    // Real last-sync time: when we actually fetched from Instagram. Lives in the cached payload (10m
    // TTL), so the UI shows the true sync moment, not when React Query happened to receive a response.
    data.synced_at = Date.now();
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// GET /api/ig/tags — media where the account is @-tagged (the brand-mentions surface; there is no
// keyword search on Instagram). The live edge only returns recent items, so we archive them in
// `ig_tags` and serve the accumulated history (DB) — they persist even after the live window drops
// them. Degrades to mock samples without a token, and to live-only without a DB.
app.get('/api/ig/tags', requireAuth, resolveIg, async (req, res) => {
  try {
    if (!req.ig) return res.json(igMock.igMockTags());
    let live = [];
    try {
      const r = await igFetch(`/${req.ig.accountId}/tags`, {
        fields: 'id,caption,username,permalink,timestamp,media_type,like_count,comments_count',
        limit: 50,
      }, req.ig.token);
      live = r.data || [];
    } catch { /* tags edge can be empty / unavailable — fall back to the archive */ }
    // The ig_tags archive is global (not yet per-channel), so only archive + serve it for the
    // global env account; per-channel connections serve the live window only until ig_tags is
    // keyed by channel (avoids cross-channel tag leakage).
    const useArchive = db.enabled && req.ig.source === 'env';
    if (useArchive && live.length) await db.upsertIgTags(live).catch(() => {});
    const data = useArchive ? await db.getIgTags(100).catch(() => live) : live;
    res.json({ data, live_count: live.length });
  } catch (e) {
    res.status(200).json({ data: [], error: e.message }); // section degrades, page survives
  }
});

// GET /api/ig/insights?days=30 — метрики аккаунта
app.get('/api/ig/insights', requireAuth, resolveIg, async (req, res, next) => {
  // Snap to a small enum before the cache key: an arbitrary user-supplied `days`
  // would mint per-value cache entries, each costing the full ~19-call Graph burst.
  const days = nearestOf(parseInt(req.query.days, 10) || 30, [7, 30, 90]);

  try {
    if (!req.ig) return res.json(igMock.igMockInsights(days));
    const cacheKey = `ig:insights:${req.ig.accountId}:${days}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const SEC = 86400;
    const now = Math.floor(Date.now() / 1000);
    const curUntil = now, curSince = now - days * SEC;
    const prevUntil = curSince, prevSince = curSince - days * SEC;

    // Instagram API with Instagram Login (graph.instagram.com): only `reach` + `follower_count`
    // return a daily time-series. Fetch the full 90-day series so the panel can window the
    // selected period (cur vs prev) for these as before.
    const dailyCall = igFetch(`/${req.ig.accountId}/insights`, { metric: 'reach,follower_count', period: 'day', since: now - 90 * SEC, until: now }, req.ig.token);

    // Engagement/visibility metrics are window AGGREGATES (total_value) with no daily series, so
    // they can't be windowed client-side. Fetch each for the current and previous selected window
    // (per-metric allSettled → one unsupported metric, e.g. profile_views, can't blank the rest),
    // then re-shape each as two synthetic daily points (prev-window + current-window) placed inside
    // those windows, so the panel's existing windowPair() KPI/delta math reads them unchanged.
    const tvNames = ['views', 'profile_views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares'];
    const tvVal = (r) => { const m = r && r.data && r.data[0]; return m && m.total_value && m.total_value.value != null ? m.total_value.value : null; };
    const fetchTv = (s, u) => Promise.allSettled(
      tvNames.map((metric) => igFetch(`/${req.ig.accountId}/insights`, { metric, metric_type: 'total_value', period: 'day', since: s, until: u }, req.ig.token)),
    );
    // follows_and_unfollows → real gross follows (FOLLOWER) AND unfollows (NON_FOLLOWER) for the
    // window (period aggregate only — the daily breakdown is empty). Surfaced as `follows`/`unfollows`
    // so the panel can show the channel's REAL movement (net = follows − unfollows), not just gross
    // new follows (which the dashboard previously reported as growth, ignoring unfollows).
    const fetchFau = (s, u) =>
      igFetch(`/${req.ig.accountId}/insights`, { metric: 'follows_and_unfollows', metric_type: 'total_value', breakdown: 'follow_type', period: 'day', since: s, until: u }, req.ig.token);
    const fauVal = (res) => {
      const block = res && res.data && res.data[0] && res.data[0].total_value && res.data[0].total_value.breakdowns;
      const results = (block && block[0] && block[0].results) || [];
      let follows = null, unfollows = null;
      results.forEach((r) => {
        const k = r.dimension_values && r.dimension_values[0];
        if (k === 'FOLLOWER') follows = r.value;
        else if (k === 'NON_FOLLOWER') unfollows = r.value;
      });
      return { follows, unfollows };
    };
    // Reach as a DEDUPLICATED window aggregate (total_value) for the current + previous window —
    // Instagram's real "Accounts reached". The daily `reach` series above is a per-day unique count
    // whose naïve sum double-counts repeat viewers (2–4× inflation vs the app). Surfaced under a
    // distinct name (`reach_window`) so it never shadows the daily series the reach chart still needs.
    const fetchReachWin = (s, u) => igFetch(`/${req.ig.accountId}/insights`, { metric: 'reach', metric_type: 'total_value', period: 'day', since: s, until: u }, req.ig.token);
    const [dailyR, curR, prevR, fauCurR, fauPrevR, reachWinCurR, reachWinPrevR] = await Promise.all([
      dailyCall.catch(() => null),
      fetchTv(curSince, curUntil),
      fetchTv(prevSince, prevUntil),
      fetchFau(curSince, curUntil).catch(() => null),
      fetchFau(prevSince, prevUntil).catch(() => null),
      fetchReachWin(curSince, curUntil).catch(() => null),
      fetchReachWin(prevSince, prevUntil).catch(() => null),
    ]);
    const out = dailyR && dailyR.data ? [...dailyR.data] : [];
    const curPoint = new Date(curUntil * 1000).toISOString();
    const prevPoint = new Date((prevSince + Math.floor((days * SEC) / 2)) * 1000).toISOString();
    const pushAgg = (metric, cur, prev) => {
      if (cur == null && prev == null) return;
      const values = [];
      if (prev != null) values.push({ value: prev, end_time: prevPoint });
      if (cur != null) values.push({ value: cur, end_time: curPoint });
      out.push({ name: metric, period: 'day', values, total_value: { value: cur } });
    };
    tvNames.forEach((metric, i) => {
      pushAgg(
        metric,
        curR[i].status === 'fulfilled' ? tvVal(curR[i].value) : null,
        prevR[i].status === 'fulfilled' ? tvVal(prevR[i].value) : null,
      );
    });
    const fauCur = fauVal(fauCurR), fauPrev = fauVal(fauPrevR);
    pushAgg('follows', fauCur.follows, fauPrev.follows);
    pushAgg('unfollows', fauCur.unfollows, fauPrev.unfollows);
    pushAgg('reach_window', tvVal(reachWinCurR), tvVal(reachWinPrevR));
    const data = { data: out };
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// GET /api/ig/posts?limit=20 — последние посты с инсайтами и превью
app.get('/api/ig/posts', requireAuth, resolveIg, async (req, res, next) => {
  // Snap to a small enum before the cache key (each post costs its own insights call,
  // so per-value cache entries multiply Graph quota burn).
  const limit = nearestOf(parseInt(req.query.limit, 10) || 20, [6, 12, 25]);
  try {
    if (!req.ig) return res.json(igMock.igMockPosts(limit));
    const cacheKey = `ig:posts:${req.ig.accountId}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const mediaRes = await igFetch(`/${req.ig.accountId}/media`, {
      fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
      limit
    }, req.ig.token);

    const posts = await Promise.all(
      (mediaRes.data || []).map(async (post) => {
        // impressions deprecated 2025 → views. Reels carry watch-time (ms), only valid on REELS.
        const base = 'reach,views,shares,saved,total_interactions';
        const metric = post.media_product_type === 'REELS'
          ? `${base},ig_reels_avg_watch_time,ig_reels_video_view_total_time`
          : base;
        try {
          const ins = await igFetch(`/${post.id}/insights`, { metric, metric_type: 'total_value' }, req.ig.token);
          const metrics = {};
          (ins.data || []).forEach((m) => {
            metrics[m.name] = (m.total_value && m.total_value.value != null)
              ? m.total_value.value
              : (m.values && m.values[0] ? m.values[0].value : 0);
          });
          return { ...post, ...metrics };
        } catch {
          return post;
        }
      })
    );

    const result = { data: posts };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// GET /api/ig/breakdowns — audience demographics + format/contact breakdowns (modern
// total_value envelope, Graph v22+). Mock-backed when no creds.
app.get('/api/ig/breakdowns', requireAuth, resolveIg, async (req, res) => {
  const allowed = ['last_14_days', 'last_30_days', 'last_90_days'];
  const timeframe = allowed.includes(req.query.timeframe) ? req.query.timeframe : 'last_30_days';
  try {
    if (!req.ig) return res.json(igMock.igMockBreakdowns(timeframe));
    const cacheKey = `ig:breakdowns:${req.ig.accountId}:${timeframe}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const calls = [
      { metric: 'follower_demographics', breakdown: 'age', period: 'lifetime', metric_type: 'total_value', timeframe },
      { metric: 'follower_demographics', breakdown: 'gender', period: 'lifetime', metric_type: 'total_value', timeframe },
      { metric: 'follower_demographics', breakdown: 'country', period: 'lifetime', metric_type: 'total_value', timeframe },
      { metric: 'follower_demographics', breakdown: 'city', period: 'lifetime', metric_type: 'total_value', timeframe },
      { metric: 'total_interactions', breakdown: 'media_product_type', period: 'day', metric_type: 'total_value' },
      { metric: 'profile_links_taps', breakdown: 'contact_button_type', period: 'day', metric_type: 'total_value' },
    ];
    const settled = await Promise.allSettled(
      calls.map((c) => igFetch(`/${req.ig.accountId}/insights`, c, req.ig.token)),
    );
    const data = settled
      .filter((s) => s.status === 'fulfilled')
      .flatMap((s) => s.value?.data || []);
    const result = { data };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(200).json({ data: [], error: e.message }); // graceful: section degrades, page survives
  }
});

// GET /api/ig/online — online-followers hourly map (best-time heatmap). Flaky metric →
// always 200, empty data[] on failure so the heatmap degrades instead of crashing.
app.get('/api/ig/online', requireAuth, resolveIg, async (req, res) => {
  try {
    if (!req.ig) return res.json(igMock.igMockOnlineFollowers());
    const cacheKey = `ig:online:${req.ig.accountId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await igFetch(`/${req.ig.accountId}/insights`, { metric: 'online_followers', period: 'lifetime' }, req.ig.token);
    const result = { data: data?.data || [] };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(200).json({ data: [], error: e.message });
  }
});

// GET /api/ig/stories — active stories (last 24h) + per-story insights/navigation. Cached
// briefly (3 min): the fan-out costs 1+~8 Graph calls PER STORY, so serving it uncached on
// every view self-burns the quota; tolerates per-story errors (#10 <5 viewers), returns []
// gracefully. Per-story metrics fetched INDEPENDENTLY (allSettled): on the Instagram-Login API a single
// unsupported story metric makes a *combined* /insights call fail wholesale, which previously
// dropped the entire story to null → the section showed "no stories" even when stories existed.
const STORY_METRICS = ['reach', 'views', 'replies', 'shares', 'follows', 'profile_visits', 'total_interactions'];
const igMetricVal = (j) => {
  const m = j && j.data && j.data[0];
  if (!m) return null;
  if (m.total_value && m.total_value.value != null) return m.total_value.value;
  if (m.values && m.values[0] && m.values[0].value != null) return m.values[0].value;
  return null;
};

const IG_STORIES_TTL = 180 * 1000;

app.get('/api/ig/stories', requireAuth, resolveIg, async (req, res) => {
  try {
    if (!req.ig) return res.json(igMock.igMockStories());
    const cacheKey = `ig:stories:${req.ig.accountId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const list = await igFetch(`/${req.ig.accountId}/stories`, {
      fields: 'id,media_type,timestamp,permalink,thumbnail_url',
    }, req.ig.token);
    const stories = await Promise.all(
      (list.data || []).map(async (s) => {
        const out = { ...s };
        // Each metric independently — one unsupported metric blanks only itself; the story and
        // its remaining metrics always survive (the story is never dropped).
        const settled = await Promise.allSettled(
          STORY_METRICS.map((metric) => igFetch(`/${s.id}/insights`, { metric, metric_type: 'total_value' }, req.ig.token)),
        );
        settled.forEach((r, i) => {
          if (r.status !== 'fulfilled') return;
          const v = igMetricVal(r.value);
          if (v != null) out[STORY_METRICS[i]] = v;
        });
        // Navigation breakdown (tap_forward/back/exit, swipe_forward) — isolated so a breakdown
        // failure can't blank the numeric metrics above.
        try {
          const navRes = await igFetch(`/${s.id}/insights`, {
            metric: 'navigation', metric_type: 'total_value', breakdown: 'story_navigation_action_type',
          }, req.ig.token);
          const m = (navRes.data || []).find((x) => x.name === 'navigation');
          if (m && m.total_value) {
            const block = m.total_value.breakdowns && m.total_value.breakdowns[0];
            if (block) {
              const nav = {};
              (block.results || []).forEach((r) => {
                const k = r.dimension_values && r.dimension_values[0];
                if (k) nav[k] = r.value;
              });
              out.navigation = nav;
            }
            out.navigation_total = m.total_value.value != null ? m.total_value.value : 0;
          }
        } catch { /* navigation optional */ }
        // Derive total_interactions if the metric itself was unsupported for this media type.
        if (out.total_interactions == null) {
          out.total_interactions = Number(out.replies || 0) + Number(out.shares || 0);
        }
        return out;
      }),
    );
    const result = { data: stories }; // never filter — a story must survive insight failures
    cacheSet(cacheKey, result, IG_STORIES_TTL);
    res.json(result);
  } catch (e) {
    res.status(200).json({ data: [], error: e.message });
  }
});

// GET /api/ig/history?days=400 — persisted daily IG series (Postgres ig_daily), mirroring
// /api/history/channel for TG. This is the DB-first read path: IG's live window is tiny (~30d for
// follower_count, nothing for reach beyond the API cap), so the accumulated history lives here.
// resolveIg gives us req.ig.channelId ONLY after getChannel() passed (ownership enforced) — so we
// serve history for the requester's own connected channel and no one else's. The env/mock fallback
// (channelId null) has no per-channel rows → [] → the client transparently keeps its live series.
app.get('/api/ig/history', requireAuth, resolveIg, async (req, res) => {
  const days = Math.min(1000, parseInt(req.query.days, 10) || 400);
  const channelId = req.ig && req.ig.channelId;
  try {
    res.json({ enabled: db.enabled, rows: channelId ? await db.listIgDaily(channelId, days) : [] });
  } catch (e) {
    res.status(200).json({ enabled: db.enabled, rows: [], error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  IG-СБОР ДЛЯ КРОНА — тот же Graph, но пишем в Postgres (история)
// ════════════════════════════════════════════════════════════════
// IG отдаёт только короткое окно (сторис 24ч, серия follower_count ~30д, у демографии
// истории НЕТ). Крон снимает данные раз в день и складывает в БД, чтобы копить историю
// для будущих графиков. Это НЕ req/res-путь: resolveIg тут неприменим (нет req, нет
// проверки владельца — крон доверенный). Мы напрямую дешифруем токен и зовём igFetch,
// как и живые роуты, но каждый вызов обёрнут в свой try/catch: один битый токен или
// квота-ошибка не должны трогать остальные аккаунты и НИКОГДА не касаются ответа крона
// (весь IG-сбор идёт fire-and-forget ПОСЛЕ res.json, как processReportSchedules).

// Достаём total_value одной total_value-метрики из ответа /insights.
const igTvVal = (r) => { const m = r && r.data && r.data[0]; return m && m.total_value && m.total_value.value != null ? m.total_value.value : null; };
// Разбираем follows_and_unfollows (breakdown=follow_type) → { follows, unfollows }.
const igFauVal = (res) => {
  const block = res && res.data && res.data[0] && res.data[0].total_value && res.data[0].total_value.breakdowns;
  const results = (block && block[0] && block[0].results) || [];
  let follows = null, unfollows = null;
  results.forEach((r) => {
    const k = r.dimension_values && r.dimension_values[0];
    if (k === 'FOLLOWER') follows = r.value;
    else if (k === 'NON_FOLLOWER') unfollows = r.value;
  });
  return { follows, unfollows };
};
// Дневной fau ВЫЧИТАНИЕМ двух многодневных окон: вчера = fau[якорь, сегодня) − fau[якорь, вчера).
// Однодневное окно follows_and_unfollows на проде возвращает ПУСТОЙ breakdown (при том, что все
// остальные total_value-метрики тем же окном приходят) — из-за этого архив follows/unfollows был
// NULL с первого дня крона: гейт нарратива f7 молча не проходил, а реконструкции уровня
// «Подписчиков» не от чего строиться. Многодневные окна демонстрируемо работают (живой KPI);
// fau аддитивен по дням — разность точна. Отрицательная разность (шум финализации Meta)
// клампится в 0, вызывающий логирует warn.
const igFauDiff = (wide, narrow) => {
  const clamp = (a, b) => (a == null || b == null ? null : Math.max(0, a - b));
  return { follows: clamp(wide.follows, narrow.follows), unfollows: clamp(wide.unfollows, narrow.unfollows) };
};
const IG_TV_NAMES = ['views', 'profile_views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares'];
const igNum = (v) => (v == null || isNaN(v)) ? null : Math.round(Number(v));

// Собираем дневные метрики аккаунта ровно за ОДИН календарный день — ВЧЕРА (UTC).
// Окно строго [вчера 00:00, сегодня 00:00): сегодня частичный/нефинализированный, а окно
// ШИРЕ одного дня заставило бы соседние прогоны крона перекрываться и удваивать суммы
// total_value при агрегации по периоду (windowPair на фронте суммирует дневные строки).
// reach/follower_count — дневная серия (единственная точка за вчера), остальное — window-
// агрегаты total_value за это же однодневное окно. row.day = вчера (день, к которому относятся данные).
async function collectIgDailyForAccount(acc, token) {
  const SEC = 86400;
  const now = Math.floor(Date.now() / 1000);
  const todayMidnight = Math.floor(now / SEC) * SEC;   // UTC-полночь сегодня
  const since = todayMidnight - SEC, until = todayMidnight;   // ровно вчера, одни сутки
  const targetDay = new Date(since * 1000).toISOString().slice(0, 10);   // YYYY-MM-DD вчера
  const id = acc.ig_user_id;
  const row = { day: targetDay };
  // Дневные серии reach + follower_count — одним вызовом (одна точка за вчерашние сутки).
  try {
    const daily = await igFetch(`/${id}/insights`, { metric: 'reach,follower_count', period: 'day', since, until }, token);
    (daily.data || []).forEach((m) => {
      const vals = m.values || [];
      const last = vals.length ? vals[vals.length - 1].value : null;   // финализированная точка за вчера
      if (m.name === 'reach') row.reach = igNum(last);
      else if (m.name === 'follower_count') row.followers = igNum(last);
    });
  } catch (e) { log('warn', 'ig_cron_daily_series_failed', { channelId: acc.channel_id, error: e.message }); }
  // Window-агрегаты total_value (каждая метрика независимо — одна неподдерживаемая не рушит остальные).
  const settled = await Promise.allSettled(
    IG_TV_NAMES.map((metric) => igFetch(`/${id}/insights`, { metric, metric_type: 'total_value', period: 'day', since, until }, token)));
  settled.forEach((r, i) => { if (r.status === 'fulfilled') row[IG_TV_NAMES[i]] = igNum(igTvVal(r.value)); });
  // follows_and_unfollows → follows / unfollows за вчера. НЕ однодневным окном (оно возвращает
  // пустой breakdown — см. igFauDiff выше), а разностью двух окон с общим якорем −8 дней:
  // wide = [якорь, сегодня) покрывает вчера, narrow = [якорь, вчера) — нет; wide − narrow = вчера.
  try {
    const anchor = until - 8 * SEC;
    const fauArgs = { metric: 'follows_and_unfollows', metric_type: 'total_value', breakdown: 'follow_type', period: 'day' };
    const [wideRes, narrowRes] = await Promise.all([
      igFetch(`/${id}/insights`, { ...fauArgs, since: anchor, until }, token),
      igFetch(`/${id}/insights`, { ...fauArgs, since: anchor, until: since }, token),
    ]);
    const wide = igFauVal(wideRes), narrow = igFauVal(narrowRes);
    if ((wide.follows != null && narrow.follows != null && wide.follows < narrow.follows) ||
        (wide.unfollows != null && narrow.unfollows != null && wide.unfollows < narrow.unfollows)) {
      log('warn', 'ig_cron_fau_negative_diff', { channelId: acc.channel_id, wide, narrow });
    }
    const day = igFauDiff(wide, narrow);
    row.follows = igNum(day.follows); row.unfollows = igNum(day.unfollows);
  } catch (e) { log('warn', 'ig_cron_fau_failed', { channelId: acc.channel_id, error: e.message }); }
  // Абсолютный уровень базы (профильный followers_count) — исторических уровней IG не отдаёт,
  // поэтому фиксируем «сейчас» при каждом дневном сборе. Ставится на вчерашнюю строку: сбор
  // идёт ранним утром, значение ≈ уровень конца вчерашнего дня (честная погрешность в часы,
  // фронт использует эти точки как якоря графика уровня «Подписчики»).
  try {
    const prof = await igFetch(`/${id}`, { fields: 'followers_count' }, token);
    row.followers_total = igNum(prof && prof.followers_count);
  } catch (e) { log('warn', 'ig_cron_followers_total_failed', { channelId: acc.channel_id, error: e.message }); }
  await db.upsertIgDaily(acc.channel_id, [row]);
  return row;
}

// Per-media lifetime-инсайты. Квота-бюджет: тянем insights только для НОВЫХ или
// «молодых» медиа (<7 дней) — у старых lifetime-числа почти не двигаются, а фан-аут
// «25 медиа × N вызовов» каждый день сжигает квоту зря. Одна строка на (media, day) →
// накопительная траектория.
const IG_MEDIA_INSIGHT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
async function collectIgMediaForAccount(acc, token, day) {
  const id = acc.ig_user_id;
  const mediaRes = await igFetch(`/${id}/media`, {
    fields: 'id,media_type,media_product_type,timestamp,like_count,comments_count', limit: 25,
  }, token);
  const list = (mediaRes.data || []).filter((post) => {
    const t = post.timestamp ? new Date(post.timestamp).getTime() : NaN;
    return !Number.isFinite(t) || (Date.now() - t) <= IG_MEDIA_INSIGHT_MAX_AGE_MS;   // новые/молодые
  });
  const rows = [];
  for (const post of list) {   // последовательно — по-доброму к квоте одного токена
    try {
      const ins = await igFetch(`/${post.id}/insights`, { metric: 'reach,views,shares,saved,total_interactions', metric_type: 'total_value' }, token);
      const m = {};
      (ins.data || []).forEach((x) => { m[x.name] = igNum(x.total_value && x.total_value.value != null ? x.total_value.value : (x.values && x.values[0] ? x.values[0].value : null)); });
      rows.push({
        media_id: String(post.id), day,
        reach: m.reach ?? null, views: m.views ?? null, shares: m.shares ?? null,
        saved: m.saved ?? null, total_interactions: m.total_interactions ?? null,
        likes: igNum(post.like_count), comments: igNum(post.comments_count),
      });
    } catch (e) { log('warn', 'ig_cron_media_insight_failed', { channelId: acc.channel_id, media: post.id, error: e.message }); }
  }
  if (rows.length) await db.upsertIgMediaDaily(acc.channel_id, rows);
  return rows.length;
}

// Демография / online / stories — истории у Meta НЕТ (демография = текущий срез,
// сторис живут 24ч), поэтому снимаем сырой payload «как есть» в raw_snapshots, чтобы
// СТРОИТЬ свою историю. Каждая секция изолирована: сбой одной не трогает остальные.
async function collectIgSnapshotsForAccount(acc, token, day) {
  const id = acc.ig_user_id;
  // Demographics — те же 6 breakdown-вызовов, что и роут /breakdowns.
  try {
    const calls = [
      { metric: 'follower_demographics', breakdown: 'age', period: 'lifetime', metric_type: 'total_value', timeframe: 'last_30_days' },
      { metric: 'follower_demographics', breakdown: 'gender', period: 'lifetime', metric_type: 'total_value', timeframe: 'last_30_days' },
      { metric: 'follower_demographics', breakdown: 'country', period: 'lifetime', metric_type: 'total_value', timeframe: 'last_30_days' },
      { metric: 'follower_demographics', breakdown: 'city', period: 'lifetime', metric_type: 'total_value', timeframe: 'last_30_days' },
      { metric: 'total_interactions', breakdown: 'media_product_type', period: 'day', metric_type: 'total_value' },
      { metric: 'profile_links_taps', breakdown: 'contact_button_type', period: 'day', metric_type: 'total_value' },
    ];
    const settled = await Promise.allSettled(calls.map((c) => igFetch(`/${id}/insights`, c, token)));
    const data = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value?.data || []);
    if (data.length) await db.saveRawSnapshot(acc.channel_id, 'ig', 'demographics', day, { data });
  } catch (e) { log('warn', 'ig_cron_demographics_failed', { channelId: acc.channel_id, error: e.message }); }
  // Online followers — почасовая карта (часто пустая → пишем только непустое).
  try {
    const online = await igFetch(`/${id}/insights`, { metric: 'online_followers', period: 'lifetime' }, token);
    const data = online?.data || [];
    if (data.length) await db.saveRawSnapshot(acc.channel_id, 'ig', 'online', day, { data });
  } catch (e) { log('warn', 'ig_cron_online_failed', { channelId: acc.channel_id, error: e.message }); }
  // Stories — живут ~24ч, снимаем список + per-story insights (allSettled), иначе теряются навсегда.
  // Кэп фан-аута: каждая сторис = 7 вызовов insights; ограничиваем число обрабатываемых сторис,
  // чтобы всплеск активных сторис не сжёг квоту токена за один прогон (типично их единицы).
  const IG_STORY_MAX = 30;
  try {
    const listRes = await igFetch(`/${id}/stories`, { fields: 'id,media_type,timestamp,permalink,thumbnail_url' }, token);
    const storyList = (listRes.data || []).slice(0, IG_STORY_MAX);
    if ((listRes.data || []).length > IG_STORY_MAX) {
      log('warn', 'ig_cron_stories_truncated', { channelId: acc.channel_id, total: listRes.data.length, cap: IG_STORY_MAX });
    }
    const stories = await Promise.all(storyList.map(async (s) => {
      const out = { ...s };
      const st = await Promise.allSettled(STORY_METRICS.map((metric) => igFetch(`/${s.id}/insights`, { metric, metric_type: 'total_value' }, token)));
      st.forEach((r, i) => { if (r.status === 'fulfilled') { const v = igMetricVal(r.value); if (v != null) out[STORY_METRICS[i]] = v; } });
      return out;
    }));
    if (stories.length) await db.saveRawSnapshot(acc.channel_id, 'ig', 'stories', day, { data: stories });
  } catch (e) { log('warn', 'ig_cron_stories_failed', { channelId: acc.channel_id, error: e.message }); }
}

// Полный дневной сбор для одного IG-аккаунта: дешифровка токена (+ opportunistic refresh,
// чтобы крон заодно держал 60-дневный токен живым), затем daily / media / snapshots. Любой
// сбой одной секции логируется и НЕ прерывает остальные и не всплывает выше.
async function collectIgForAccount(acc, day) {
  let token;
  try {
    token = igCrypto.decrypt(acc.access_token_enc);   // бросает при отсутствии/ротации IG_TOKEN_KEY или битом блобе
  } catch (e) {
    log('warn', 'ig_token_decrypt_failed', { channelId: acc.channel_id, error: e.message });
    return;   // один недешифруемый аккаунт не рушит весь прогон
  }
  token = await refreshIgIfNeeded(acc.channel_id, token, acc.token_expires_at);   // крон = heartbeat рефреша токена
  try { await collectIgDailyForAccount(acc, token); }        catch (e) { log('error', 'ig_cron_daily_failed', { channelId: acc.channel_id, error: e.message }); }
  try { await collectIgMediaForAccount(acc, token, day); }   catch (e) { log('error', 'ig_cron_media_failed', { channelId: acc.channel_id, error: e.message }); }
  try { await collectIgSnapshotsForAccount(acc, token, day); } catch (e) { log('error', 'ig_cron_snapshots_failed', { channelId: acc.channel_id, error: e.message }); }
}

// Оркестратор персистенса (вызывается fire-and-forget ПОСЛЕ ответа крона):
//   (a) сырой снимок TG /graphs для центрального канала (catch-all для серий, которые
//       не ложатся в channel_daily: views_by_source, languages, top_hours и т.п.);
//   (b) IG-сбор по КАЖДОМУ аккаунту из ig_accounts (не только центральный — IG цепляется
//       к любому каналу), ПОСЛЕДОВАТЕЛЬНО, чтобы не устраивать thundering herd;
//   (c) прунинг raw_snapshots. Ничего не бросает наружу.
async function processPersistence(centralChannelId, graphs) {
  if (!db.enabled) return;
  const day = new Date().toISOString().slice(0, 10);
  // (a) сырой TG /graphs — payload уже в руках (лишнего mtproto-вызова нет).
  if (centralChannelId && graphs && graphs.available) {
    try { await db.saveRawSnapshot(centralChannelId, 'tg', 'graphs', day, graphs); }
    catch (e) { log('error', 'tg_graphs_snapshot_failed', { channelId: centralChannelId, error: e.message }); }
  }
  // (b) IG по каждому подключённому аккаунту. Без IG_TOKEN_KEY токенов нет — пропускаем.
  if (igCrypto.configured()) {
    let accounts = [];
    try { accounts = await db.listIgAccounts(); }
    catch (e) { log('error', 'ig_list_accounts_failed', { error: e.message }); }
    for (const acc of accounts) {
      try { await collectIgForAccount(acc, day); }   // sequential: по-доброму к квоте
      catch (e) { log('error', 'ig_collect_account_failed', { channelId: acc && acc.channel_id, error: e.message }); }
    }
  }
  // (c) ретеншн — не даём append-only таблицам расти безгранично.
  try { await db.pruneRawSnapshots(); }
  catch (e) { log('error', 'raw_snapshots_prune_failed', { error: e.message }); }
  try { await db.pruneIgMediaDaily(); }
  catch (e) { log('error', 'ig_media_daily_prune_failed', { error: e.message }); }
  // (d) capacity: nightly monthly rollup of channel_daily (ops/CAPACITY_SCALE_1K_10K.md). INERT by
  // default — only runs when CAPACITY_ROLLUPS=1, and the jobs row makes exactly one web instance
  // recompute it per day (idempotent, cheap: bounded to recent months). Nothing reads channel_monthly
  // yet, so this is groundwork; enable it before wiring the long-range history reader.
  if (process.env.CAPACITY_ROLLUPS === '1') {
    const rollupKey = `channel_monthly:${day}`;
    try { await db.runJobOnce('rollup_channel_monthly', rollupKey, () => db.rollupChannelMonthly(3)); }
    catch (e) { log('error', 'channel_monthly_rollup_failed', { error: e.message }); }
  }
}

// One mtproto post ({id,date,views,reactions,forwards,replies,media_type,text,hashtags}) → a
// posts-table row. Shared by the central ingest and the QR-channel collection so both compute ERV/
// virality identically.
function tgPostToRow(p) {
  const reach = p.views || 0;
  const eng = (p.reactions || 0) + (p.forwards || 0) + (p.replies || 0);
  return {
    post_id: p.id, date_published: p.date,
    views: p.views || 0, reactions: p.reactions || 0, forwards: p.forwards || 0, replies: p.replies || 0,
    erv: reach > 0 ? eng / reach * 100 : null,
    virality: reach > 0 ? (p.forwards || 0) / reach * 100 : null,
    media_type: p.media_type, caption: captionSnippet(p.text), hashtags: p.hashtags || [],
  };
}

// Write one channel's collected bundle to Postgres exactly like a collector push: the snapshot
// (what /api/tg/full + the /api/tg/mtproto/* routes serve for non-central channels) plus the
// time-series (channel_daily from graphs, posts). Best-effort per part.
async function persistTgBundle(channelId, bundle, day) {
  if (!channelId || !bundle || typeof bundle !== 'object') return;
  const posts = Array.isArray(bundle.posts) ? bundle.posts : [];
  await db.saveSnapshot(channelId, {
    channel:       bundle.channel || {},
    views_summary: bundle.views_summary || null,
    posts,
    stats:         bundle.stats || null,
    graphs:        bundle.graphs || null,
  });
  if (bundle.graphs && bundle.graphs.available) {
    const dailyRows = db.graphsToDailyRows(bundle.graphs);
    if (dailyRows.length) await db.upsertChannelDaily(channelId, dailyRows);
    await db.saveRawSnapshot(channelId, 'tg', 'graphs', day, bundle.graphs).catch(() => {});
  }
  if (posts.length) await db.upsertPosts(channelId, posts.map(tgPostToRow));
}

// Fetch one QR channel's bundle via the (already-decrypted) session and persist it. Throws on
// mtproto/collect failure — callers decide how to handle (log + continue).
async function collectQrChannel(sessionStr, ch, day) {
  const ref = ch.username || String(ch.tg_channel_id);
  const bundle = await mtprotoPost('/qr/collect', {
    body: { session: sessionStr, channel: ref, posts_limit: 100, graph_points: 400 },
    timeoutMs: MTPROTO_TIMEOUT_HEAVY_MS,
  });
  await persistTgBundle(ch.id, bundle, day);
}

// Immediate best-effort collection for freshly-added channels so the dashboard fills within seconds
// instead of waiting for the nightly cron. Fire-and-forget; sequential (kind to the user's session's
// flood limits); never throws to the caller.
async function collectQrChannelsNow(sess, channels) {
  if (!sess || !tgCrypto.configured() || !MTPROTO_TOKEN) return;
  let sessionStr;
  try { sessionStr = tgCrypto.decrypt(sess.session_enc); } catch { return; }
  const day = new Date().toISOString().slice(0, 10);
  for (const ch of channels) {
    if (!ch || ch.tg_channel_id == null) continue;
    try { await collectQrChannel(sessionStr, ch, day); }
    catch (e) { log('error', 'tg_qr_collect_now_failed', { channelId: ch.id, error: e.message }); }
  }
}

// Collect QR-connected channels (source='qr') into Postgres using each user's stored session — the
// server acts as their collector, so the dashboard renders them like any collector channel. Runs
// fire-and-forget after the central ingest; durable per (channel, day) so a repeat trigger resumes
// unfinished channels; sequential + per-channel try/catch so one bad session / channel / FloodWait
// never blocks the others or the critical central ingest. Sessions are decrypted ONLY here and handed
// to the isolated mtproto /qr/collect — never logged, never sent to a client.
const TG_QR_MAX_CHANNELS_PER_RUN = 200;

async function processTgQrCollection() {
  if (!db.enabled || !tgCrypto.configured() || !MTPROTO_TOKEN) return;
  const day = new Date().toISOString().slice(0, 10);
  let sessions = [];
  try { sessions = await db.listTgSessions(); }
  catch (e) { log('error', 'tg_qr_list_sessions_failed', { error: e.message }); return; }

  let done = 0, collected = 0, skipped = 0, failed = 0, capped = false;
  for (const s of sessions) {
    if (done >= TG_QR_MAX_CHANNELS_PER_RUN) { capped = true; break; }
    let sessionStr;
    try { sessionStr = tgCrypto.decrypt(s.session_enc); }
    catch { log('error', 'tg_qr_decrypt_failed', { uid: s.uid }); continue; }

    let chans = [];
    try { chans = (await db.listChannels({ uid: s.uid })).filter((c) => c.source === 'qr' && c.tg_channel_id != null); }
    catch (e) { log('error', 'tg_qr_list_channels_failed', { uid: s.uid, error: e.message }); continue; }

    for (const ch of chans) {
      if (done >= TG_QR_MAX_CHANNELS_PER_RUN) { capped = true; break; }
      let started = false;
      try {
        const out = await db.runJobOnce('qr_collect', `${ch.id}:${day}`, () => {
          started = true;
          return collectQrChannel(sessionStr, ch, day);
        });
        if (out.skipped) { skipped++; continue; }
        done++;
        collected++;
      }
      catch (e) {
        if (started) done++;
        failed++;
        log('error', 'tg_qr_collect_failed', { channelId: ch.id, error: e.message });
      }
    }
  }
  log(capped ? 'warn' : 'info', 'tg_qr_collection_done', { collected, skipped, failed, capped });
}

// Instagram OAuth (per-channel connect) routes are isolated in routes/ig-oauth.js — the
// signed-state helpers, the connect-config gate, IG cache purge and the token exchange live there.
registerIgOauthRoutes({
  app, db, requireAuth, audit, log, fetchWithTimeout, asyncHandler,
  appBase, cache, igConfigured, igCrypto, AUTH_SECRET, IG_GRAPH,
});

// ── Telegram Bot API env — read here; still surfaced by /api/health + the boot banner, and
// injected into routes/tg.js (which owns the Bot-API fetch helper and the /api/tg/* handlers). ──
const TG_TOKEN   = process.env.TG_BOT_TOKEN;
const TG_CHANNEL = process.env.TG_CHANNEL;

registerChannelsRoutes({ app, db, requireAuth, audit, getDbReady: () => dbReady });

// Named report CRUD is isolated in its own route module; the email schedule
// worker below remains here because it is triggered from the daily ingest cron.
registerReportsRoutes({ app, db, requireAuth, audit });

/* Email-выгрузка отчётов (v1). Дёргается fire-and-forget из дневного ingest-крона
   (единственный ежедневный тик системы — отдельного планировщика нет): weekly уходит
   в понедельник UTC, monthly — 1-го числа UTC. Если крон в «свой» день не сработал,
   действует catch-up: weekly шлётся, когда last_sent_at старше 8 дней, monthly — 32
   дней (первая отправка якорится к понедельнику / 1-му). Окно по last_sent_at в
   listDueReports остаётся анти-дублем, если крон сработал дважды за день. Все ошибки
   логируются и никогда не влияют на ответ ingest-а. */
// Серверный «Неделя канала» (фаза 3 нарратива): shared-движок narrative.gen.cjs + сборка входа
// из архива. Секция опциональна — без артефакта/данных письмо-ссылка уходит как раньше.
const { assembleWeekInput, reportHasWeekBlock, weekSectionHtml } = require('./lib/weekDigest');

const reportEmailHtml = (base, report, weekHtml) => emailShell(`Отчёт „${escHtml(report.name)}“`,
  `${weekHtml || ''}<p>Ваш регулярный отчёт Atlavue готов:</p>${emailBtn(`${base}/reports/${report.id}`, 'Открыть отчёт')}` +
  `<p style="color:#64748d;font-size:13px">Отчёт можно сохранить как PDF — кнопка «Печать» на странице отчёта.</p>`);

async function processReportSchedules(base) {
  if (!db.enabled) return;
  // Без почтового провайдера рассылка невозможна: dev-заглушка sendEmail вернула бы true,
  // и last_sent_at проставился бы без единого отправленного письма.
  if (!RESEND_API_KEY) {
    console.log('[reports] schedule skipped: email not configured');
    return;
  }
  const now = new Date();
  const isMonday = now.getUTCDay() === 1;    // понедельник UTC
  const isFirst  = now.getUTCDate() === 1;   // 1-е число UTC
  let candidates = [];
  try { candidates = await db.listDueReports({ weekly: true, monthly: true }); }
  catch (e) { log('error', 'report_schedule_query_failed', { error: e.message }); return; }
  // Пер-строчный гейт с catch-up вместо строгого «только в понедельник / 1-го»: если крон
  // в тот день не сработал, письмо уходит, как только last_sent_at старше 8 дней (weekly)
  // или 32 дней (monthly). Первая отправка (last_sent_at IS NULL) якорится к понедельнику /
  // 1-му. Анти-дубль в течение дня остаётся SQL-окном в listDueReports.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const olderThan = (sentAt, limitDays) =>
    sentAt != null && now.getTime() - new Date(sentAt).getTime() > limitDays * DAY_MS;
  const due = candidates.filter((r) =>
    r.schedule === 'weekly'
      ? isMonday || olderThan(r.last_sent_at, 8)
      : isFirst  || olderThan(r.last_sent_at, 32));
  // ISO-week key (YYYY-Www) so the weekly job key is stable across the whole week.
  const isoWeekKey = (d) => {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // Thursday of this ISO week
    const week = Math.ceil((((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000) + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  };
  for (const r of due) {
    // Idempotency key per (report, period): a double cron tick, the catch-up branch firing next
    // to the anchored one, or a SECOND SERVER INSTANCE can all re-discover the same candidate —
    // the jobs row makes exactly one of them send (roadmap P0 «Background job idempotency»).
    const periodKey = r.schedule === 'weekly' ? isoWeekKey(now) : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    try {
      const outcome = await db.runJobOnce('report_email', `report:${r.id}:${periodKey}`, async () => {
        // GDPR-гонка: юзер мог стереть аккаунт между снапшотом listDueReports (несёт email в
        // строке) и отправкой — перепроверяем существование, письмо на стёртый адрес не уходит.
        if (!(await db.getUserById(r.uid))) return { sent: false, erased: true };
        // «Неделя канала» в теле письма — только weekly-отчётам с week/digest-блоком. Любая
        // ошибка сборки секции НЕ роняет отправку: письмо уходит без неё (рассказ — бонус).
        let weekHtml = null;
        try {
          if (r.schedule === 'weekly' && reportHasWeekBlock(r.config)) {
            const chans = await db.listChannels({ uid: r.uid });
            const chId = chans[0] && chans[0].id;
            if (chId) {
              const [daily, posts, igDaily] = await Promise.all([
                db.getChannelHistory(chId, 35),
                db.listPostsWindow(chId, 28),
                db.listIgDaily(chId, 14),
              ]);
              weekHtml = weekSectionHtml(assembleWeekInput({ daily, posts, igDaily }));
            }
          }
        } catch (e) {
          log('warn', 'report_week_section_failed', { report_id: r.id, error: e.message });
        }
        const ok = await sendEmail(r.email, `Atlavue — отчёт „${r.name}“`, reportEmailHtml(base, r, weekHtml));
        if (ok) await db.markReportSent(r.id);
        if (!ok) throw new Error('email send failed');
        return { sent: true };
      });
      if (outcome.skipped) {
        log('info', 'report_email_deduped', { report_id: r.id, period: periodKey });
      }
    } catch (e) {
      log('error', 'report_email_failed', { report_id: r.id, error: e.message });
    }
  }
}

// Collector protocol is isolated in its own route module. The handler validates
// and normalizes the envelope before a single transactional DB call.
registerCollectorRoutes({
  app,
  db,
  express,
  rateLimit,
  isReady: () => dbReady,
  requireAuth,
  audit,
});

// ════════════════════════════════════════════════════════════════
//  TELEGRAM — Bot API + QR-connect + MTProto proxy routes → routes/tg.js
// ════════════════════════════════════════════════════════════════

// Public media proxies (thumb / channel photo) are open <img src> routes, so beyond the global
// /api limiter they get a dedicated modest per-IP limiter to keep an anonymous scraper from
// hammering the MTProto service. Defined here with the other rate limiters and injected into the
// TG routes.
const mediaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Слишком много запросов. Попробуй через минуту.' }
});

registerTgRoutes({
  app, requireAuth, resolveChannel, db, audit, log,
  cacheGet, cacheSet, asyncHandler, tgCrypto, mediaLimiter, fetchWithTimeout,
  collectQrChannelsNow, TG_TOKEN, TG_CHANNEL,
});

// ════════════════════════════════════════════════════════════════
//  ОБЩИЕ ROUTES
// ════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'pulse-analytics-web',
    uptime: Math.round(process.uptime()),
    cache:  cache.size,
    sessions: 'signed+versioned',
    database_ready: dbReady,
    request_id: req.requestId,
    env: {
      ig:  !!IG_TOKEN && !!IG_ACCOUNT,
      tg:  !!TG_TOKEN && !!TG_CHANNEL,
      auth: !!process.env.SESSION_SECRET
    }
  });
});

app.get('/api/ready', async (req, res) => {
  if (!dbReady) return res.status(503).json({ status: 'starting', request_id: req.requestId });
  try {
    const database = await db.ping();
    res.json({ status: 'ready', database, request_id: req.requestId });
  } catch (error) {
    log('error', 'readiness_failed', { request_id: req.requestId, error: error.message });
    res.status(503).json({
      status: 'not_ready',
      database: { enabled: db.enabled, ok: false },
      request_id: req.requestId,
    });
  }
});

app.delete('/api/cache', requireAuth, requireSuper, (req, res) => {
  cache.clear();
  res.json({ ok: true, message: 'Кэш сброшен' });
});

// ════════════════════════════════════════════════════════════════
//  ИСТОРИЯ (Postgres) — снэпшоты сверх 3-месячного окна Telegram
// ════════════════════════════════════════════════════════════════

// Снимок дня: тянет дневные серии из /graphs (+ посты) и upsert'ит в БД.
// Защищён отдельным токеном (НЕ командный пароль) — дёргается cron'ом.
app.post('/api/ingest/daily', asyncHandler(async (req, res) => {
  const token = req.headers['x-ingest-token'];
  if (!process.env.INGEST_TOKEN || typeof token !== 'string' || !token
      || !timingSafeEqualStr(token, process.env.INGEST_TOKEN)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  if (!db.enabled) return res.status(200).json({ ok: false, reason: 'DATABASE_URL не задан — БД выключена' });
  const channelId = await db.getOwnerChannelId();   // central channel = "collector #0"
  if (!channelId) return res.status(503).json({ ok: false, reason: 'central channel not ready' });
  try {
    // Idempotency (Ковчег): a double cron tick / a second web instance must NOT run the heavy
    // MTProto pass (/graphs + /posts + up to ~12 GetMessageStats for velocity) twice for the same
    // day. runJobOnce keyed on the UTC date makes exactly one caller do the work; a duplicate gets
    // the first run's cached result and skips both the fetch AND the fire-and-forget tails below.
    const dateKey = new Date().toISOString().slice(0, 10);
    let graphs = null;
    const outcome = await db.runJobOnce('daily_ingest', `central:${dateKey}`, async () => {
      let posts;
      [graphs, posts] = await Promise.all([
        mtprotoFetch('/graphs', { points: 400 }, MTPROTO_TIMEOUT_HEAVY_MS).catch(() => null),   // full range for the archive (dashboard uses 45)
        mtprotoFetch('/posts', { limit: 100 }).catch(() => null),
      ]);
      const velocity = await mtprotoFetch('/velocity', {}, MTPROTO_TIMEOUT_HEAVY_MS).catch(() => null);
      // All three upserts commit together (persistCentralDaily) — no half-written day.
      return db.persistCentralDaily(channelId, {
        dailyRows: db.graphsToDailyRows(graphs),
        postRows: (posts && Array.isArray(posts.posts)) ? posts.posts.map(tgPostToRow) : [],
        velocity,
      });
    });

    const result = outcome.skipped ? ((outcome.job && outcome.job.result) || {}) : outcome.result;
    // Наблюдаемость тихой смерти архива: для рабочего центрального канала graphsToDailyRows всегда
    // отдаёт полный диапазон, поэтому channel_daily=0 означает не «пустой день», а упавший тяжёлый
    // MTProto-fetch (graphs=null). Раньше это возвращалось как ok:true/HTTP 200 → крон зелёный,
    // архив молча перестаёт расти. Теперь помечаем degraded: крон роняет джобу по этому флагу
    // (нативное письмо GitHub = бесплатный проактивный алерт), а лог даёт greppable-сигнал.
    const degraded = (result.channel_daily || 0) === 0;
    if (degraded) {
      log('error', 'ingest_degraded', {
        request_id: req.requestId,
        skipped: !!outcome.skipped,
        reason: 'channel_daily=0 (upstream MTProto /graphs likely failed) — archive did not grow',
      });
    }
    res.json({ ok: true, degraded, skipped: !!outcome.skipped, channel_daily: result.channel_daily || 0, posts: result.posts || 0, velocity: !!result.velocity });

    // A duplicate day already ran the tails on the first tick — skip the redundant heavy passes.
    if (outcome.skipped) return;

    // Email-выгрузка отчётов — fire-and-forget ПОСЛЕ ответа крону: расписания
    // не должны ни задерживать, ни ломать ingest.
    processReportSchedules(appBase(req)).catch(e =>
      log('error', 'report_schedule_failed', { request_id: req.requestId, error: e.message }));

    // Персистенс истории (сырой TG /graphs + IG-сбор по всем подключённым аккаунтам
    // + прунинг) — тоже fire-and-forget ПОСЛЕ ответа: сбой Graph/квоты/БД тут НИКОГДА
    // не должен задержать или уронить TG-ingest, от которого зависит вся система.
    // `graphs` уже в руках — сырой снимок пишется без лишнего mtproto-вызова.
    processPersistence(channelId, graphs).catch(e =>
      log('error', 'persistence_failed', { request_id: req.requestId, error: e.message }));

    // QR-connected channels: server-side collection via each user's stored session (own tail so a
    // slow/broken session never delays the central ingest response above).
    processTgQrCollection().catch(e =>
      log('error', 'tg_qr_collection_failed', { request_id: req.requestId, error: e.message }));
  } catch (e) {
    // keep the { ok:false } shape for the cron, but never leak internals in the message
    log('error', 'ingest_daily_failed', { request_id: req.requestId, error: e.message, stack: e.stack });
    res.status(500).json({ ok: false, error: 'internal_error', request_id: req.requestId });
  }
}));

app.get('/api/history/channel', requireAuth, resolveChannel, async (req, res) => {
  const days = Math.min(1000, parseInt(req.query.days) || 365);
  try {
    res.json({ enabled: db.enabled, rows: await db.getChannelHistory(req.channel.id, days) });
  } catch (e) {
    res.status(200).json({ enabled: db.enabled, rows: [], error: e.message });
  }
});

app.get('/api/history/mentions', requireAuth, resolveChannel, async (req, res) => {
  try {
    const data = await db.getMentionsArchive(req.channel.id, 30);
    res.json({ enabled: db.enabled, ...(data || { available: false }) });
  } catch (e) {
    res.status(200).json({ enabled: db.enabled, available: false, error: e.message });
  }
});

// Bug tracker, crash telemetry and bug attachments are isolated in their own route module.
registerBugsRoutes({
  app,
  express,
  db,
  rateLimit,
  requireAuth,
  requireSuper,
  fetchWithTimeout,
  AUTH_SECRET,
});

// ── Sprint 3F-3 catover: new Vite/React SPA is the primary dashboard, served at '/' ──
// The dist/ bundle is produced by the Dockerfile.web build stage. CSP is stricter than
// the legacy shell: the new app has NO inline scripts (JSX auto-escapes), so script-src
// is plain 'self' — no nonce. The legacy nonce-shell stays at /legacy as a reversible
// escape hatch until the B2 cleanup (then this becomes the only HTML surface).
const APP_DIST = path.join(__dirname, '../frontend/dist');
// Hashed SPA assets at root (/assets/*). Security headers set per response.
app.use((req, res, next) => { setAppHeaders(req, res); next(); },
  express.static(APP_DIST, { index: false }));

// Pre-catover bookmarks under /app → root equivalent (302; temporary during catover).
app.get(['/app', '/app/*'], (req, res) => {
  const target = req.originalUrl.replace(/^\/app(?=[/?]|$)/, '') || '/';
  const local = target.startsWith('/') ? target : '/' + target;
  // Same-origin only: '//host' (and '/\host') is protocol-relative → open redirect.
  res.redirect(302, /^\/(?!\/|\\)/.test(local) ? local : '/');
});

// Legacy nonce-shell — reversible escape hatch, removed in 3F-3 B2 cleanup.
app.get('/legacy', sendApp);

// Unknown /api/* → JSON 404. Without this the SPA fallback served index.html with a
// 200 for any mistyped API path — clients parsed HTML, monitoring saw success.
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'not_found', request_id: req.requestId });
});

// SPA fallback: every other (non-/api, non-asset) GET serves the new app shell.
app.get('*', (req, res) => {
  setAppHeaders(req, res);
  res.sendFile(path.join(APP_DIST, 'index.html'), (err) => { if (err) res.status(404).end(); });
});

// Terminal error handler — asyncHandler rejections and next(e) land here. Known
// upstream failures carry err.status (igFetch → 502, mtprotoFetch flood → 503) and
// their message is safe to show; anything else is a plain 500 and must NOT leak
// internals (pg/driver messages) — the client gets a generic shape, the log gets
// the full error keyed by request id.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  const dbUnavailable = status === 500 && db.isDbUnavailable(err);
  const responseStatus = dbUnavailable ? 503 : status;
  log('error', 'unhandled_error', {
    request_id: req.requestId,
    method: req.method,
    path: req.path,
    status: responseStatus,
    error: err && err.message,
    stack: err && err.stack,
  });
  const body = dbUnavailable
    ? { error: 'Сервис временно недоступен, попробуйте позже', request_id: req.requestId }
    : { error: responseStatus === 500 ? 'internal_error' : String((err && err.message) || 'error'), request_id: req.requestId };
  if (err && err.retryAfter != null) {
    res.set('Retry-After', String(err.retryAfter));
    body.retry_after = err.retryAfter;
  }
  res.status(responseStatus).json(body);
});

// ── Запуск ──────────────────────────────────────────────────────
// Single-replica guardrail (ops/ADR-002-single-replica.md). Response cache, igInflight singleflight
// and the express-rate-limit stores are all in-process — correct only at ONE web replica. Railway
// doesn't expose the replica count to the app, so the operator declares it via WEB_REPLICAS; bumping
// Railway's replica slider WITHOUT the Redis-backed shared state (still unbuilt) silently multiplies
// rate limits and Graph/MTProto quota burn. Loud boot error = the tripwire for that scale-up.
if (require.main === module) {
const WEB_REPLICAS = Number(process.env.WEB_REPLICAS || '1');
if (Number.isFinite(WEB_REPLICAS) && WEB_REPLICAS > 1) {
  log('error', 'multi_replica_unsupported', {
    web_replicas: WEB_REPLICAS,
    reason: 'in-process cache + rate-limit + singleflight are per-instance; needs shared (Redis) store first — see ops/ADR-002-single-replica.md',
  });
}

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║        Atlavue Server            ║
╠══════════════════════════════════════════╣
║  URL:      http://localhost:${PORT}          ║
║  IG API:   ${IG_TOKEN ? '✅ настроен' : '❌ не задан (IG_ACCESS_TOKEN)'}           ║
║  TG API:   ${TG_TOKEN ? '✅ настроен' : '❌ не задан (TG_BOT_TOKEN)'}             ║
║  Sessions: ${process.env.SESSION_SECRET ? '✅ SESSION_SECRET задан' : '⚠️ ephemeral (dev) — задай SESSION_SECRET'}  ║
║  MTProto:  ${process.env.MTPROTO_TOKEN ? '✅ MTPROTO_TOKEN задан' : '❌ MTPROTO_TOKEN не задан'}       ║
╚══════════════════════════════════════════╝
  `);
});
}

module.exports = { app };
