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
const { log, requestContext, hashIp } = require('./lib/observability');
const { sourceRefreshLimitKey, createFixedWindowQuota } = require('./lib/rateLimitPolicy');
const { makeResolveChannel, makeServeSnapshot, hasWorkspaceRole } = require('./middleware/tenant');
const { registerCollectorRoutes } = require('./routes/collector');

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
const cspHeader = (nonce) => [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  `script-src 'self' 'nonce-${nonce}'`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
].join('; ');
function sendApp(req, res) {
  const nonce = crypto.randomBytes(16).toString('base64');
  let src = APP_HTML;
  if (!src) { try { src = fs.readFileSync(APP_HTML_PATH, 'utf8'); } catch { return res.status(500).end(); } }
  const html = src.split('<script>').join(`<script nonce="${nonce}">`);
  res.set('Content-Security-Policy', cspHeader(nonce))
     .set('X-Content-Type-Options', 'nosniff')
     .set('Referrer-Policy', 'no-referrer')
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

const SOURCE_REFRESH_LIMIT_PER_MIN = Math.max(1, parseInt(process.env.SOURCE_REFRESH_LIMIT_PER_MIN, 10) || 30);
const sourceRefreshQuota = createFixedWindowQuota({
  windowMs: 60 * 1000,
  max: SOURCE_REFRESH_LIMIT_PER_MIN,
});

function consumeSourceRefreshQuota(req, res) {
  const key = sourceRefreshLimitKey({
    session: req.user || req.session,
    ip: req.ip,
    channel: req.channel,
    ig: req.ig,
  });
  const verdict = sourceRefreshQuota.consume(key);
  res.set('RateLimit-Policy', `${verdict.limit};w=60;name="source-refresh"`);
  res.set('RateLimit-Remaining', String(verdict.remaining));
  res.set('RateLimit-Reset', String(Math.ceil(verdict.resetAt / 1000)));
  if (verdict.allowed) return true;
  res.set('Retry-After', String(verdict.retryAfterSeconds));
  res.status(429).json({
    error: 'Слишком много обновлений источника. Попробуй через минуту.',
    scope: 'source-refresh',
  });
  return false;
}

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
const IG_STATE_KEY = crypto.createHmac('sha256', AUTH_SECRET).update('ig-state').digest();
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

// Live MTProto exists only for the 'central' channel (the owner's session).
// Other channels are fed by collectors → their data comes from Postgres, so the
// live-proxy routes answer with a soft "not live" marker for them.
function notCentral(req, res) {
  if (req.channel && req.channel.source === 'central') return false;
  res.json({ available: false, source: 'collector', empty: true });
  return true;
}

const serveSnapshot = makeServeSnapshot({ db });

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
const verifyEmailHtml = (link) => emailShell('Подтверди email',
  `<p>Активируй аккаунт в Atlavue:</p>${emailBtn(link, 'Подтвердить email')}<p style="color:#64748d;font-size:13px">Ссылка действует 24 часа. Если это были не вы — проигнорируйте письмо.</p>`);
const resetEmailHtml = (link) => emailShell('Сброс пароля',
  `<p>Задай новый пароль:</p>${emailBtn(link, 'Сбросить пароль')}<p style="color:#64748d;font-size:13px">Ссылка действует 1 час. Если это были не вы — проигнорируйте, пароль не изменится.</p>`);
const existsEmailHtml = (base) => emailShell('Аккаунт уже существует',
  `<p>На этот email уже есть аккаунт Atlavue. Забыли пароль — <a href="${escHtml(base)}/?forgot=1">сбросьте его</a>.</p>`);

// ════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════════════

// Registration (self-serve, Sprint 1B): create an 'unverified' account and email
// a verification link. Anti-enumeration — always the same generic response; an
// already-registered email gets an "account exists" nudge instead.
app.post('/api/auth/register', authLimiter, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена — регистрация недоступна' });
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  const password = String((req.body && req.body.password) || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Некорректный email' });
  if (password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });
  const generic = { status: 'check_email', message: 'Проверь почту — если email свободен, мы отправили ссылку для подтверждения.' };
  res.json(generic);          // respond first → constant-time, no existing-vs-new timing oracle
  try {
    const base = appBase(req);
    const existing = await db.getUserByEmail(email);
    if (existing) {           // don't reveal it's taken; nudge the real owner, cooldown-gated like real tokens
      const eid = await db.createEmailToken(existing.id, 'exists', sha256(newToken()), new Date(Date.now() + 60000));
      if (eid) sendEmail(email, 'Аккаунт Atlavue уже существует', existsEmailHtml(base)).catch(() => {});
      return;
    }
    const u = await db.createUser({ email, pass_hash: hashPassword(password), role: 'user', status: 'unverified' });
    const raw = newToken();
    const id = await db.createEmailToken(u.id, 'verify', sha256(raw), new Date(Date.now() + VERIFY_TTL));
    const link = `${base}/verify?token=${raw}`;
    if (id) await sendEmail(email, 'Подтверди email — Atlavue', verifyEmailHtml(link), link);
  } catch (e) {
    if (e.code !== '23505') console.error('[register]', e.message);   // already responded generically
  }
});

// Login: account (email + password) only.
app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  const password = String((req.body && req.body.password) || '');
  if (!email || !password) return res.status(400).json({ error: 'Укажи email и пароль' });
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const expires = Date.now() + SESSION_TTL;
  try {
    const u = await db.getUserByEmail(email);
    const ok = u ? verifyPassword(password, u.pass_hash) : verifyPassword(password, DUMMY_HASH);  // constant-cost
    if (!u || !ok) return res.status(403).json({ error: 'Неверный email или пароль' });
    if (u.status === 'unverified') return res.status(403).json({ error: 'Подтверди email — ссылка пришла при регистрации', code: 'unverified' });
    if (u.status === 'pending')    return res.status(403).json({ error: 'Аккаунт ждёт одобрения администратором' });
    if (u.status !== 'active')     return res.status(403).json({ error: 'Аккаунт отключён' });
    const token = signSession({ uid: u.id, role: u.role, exp: expires, tokenVersion: u.token_version });
    req.user = { uid: u.id, role: u.role, email: u.email };
    audit(req, 'auth.login', {}).catch(() => {});
    return res.json({ token,
      expiresAt: new Date(expires).toISOString(), user: { email: u.email, role: u.role } });
  } catch (e) { return next(e); }
});

// Public runtime config for the SPA (no secrets). Currently just the Google client id so the login
// UI can decide whether to show the "Sign in with Google" button.
app.get('/api/config', (req, res) => {
  res.json({ google_client_id: GOOGLE_CLIENT_ID || null });
});

// "Sign in with Google": the frontend GSI button returns an ID token (JWT); we verify it with Google
// (validates signature + expiry), check it was minted for THIS app and carries a verified email,
// then create/find the account and issue our own session. A verified Google email means we can skip
// our email-verify step (account is active immediately). Existing email/password accounts with the
// same verified email are linked (logged into).
app.post('/api/auth/google', authLimiter, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: 'Вход через Google не настроен на сервере' });
  const credential = String((req.body && req.body.credential) || '');
  if (!credential) return res.status(400).json({ error: 'Нет токена Google' });
  try {
    const r = await fetchWithTimeout('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), {}, 8000);
    const info = await r.json().catch(() => ({}));
    // aud = our app; iss = Google; email must be Google-verified. (tokeninfo already rejects a bad
    // signature or an expired token with a non-200, so a valid `sub` here means the JWT is genuine.)
    if (!r.ok || !info.sub) {
      log('warn', 'google_tokeninfo_rejected', { status: r.status });
      return res.status(401).json({ error: 'Google не подтвердил вход' });
    }
    if (info.aud !== GOOGLE_CLIENT_ID) return res.status(401).json({ error: 'Токен не для этого приложения' });
    if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') return res.status(401).json({ error: 'Неверный источник токена' });
    if (String(info.email_verified) !== 'true' || !info.email) return res.status(401).json({ error: 'Email Google не подтверждён' });
    const email = String(info.email).toLowerCase().trim();
    let u = await db.getUserByEmail(email);
    if (u && u.status === 'disabled') return res.status(403).json({ error: 'Аккаунт отключён' });
    if (!u) {
      // New account — Google already verified the email, so it's active with an unusable password
      // (password login stays impossible until the user sets one via "forgot password").
      const randomPass = hashPassword(crypto.randomBytes(32).toString('hex'));
      u = await db.createUser({ email, pass_hash: randomPass, role: 'user', status: 'active' });
    } else if (u.status !== 'active') {
      // Existing but never-verified account (created via email/password; ownership unproven — it could
      // be an attacker pre-registration seeded with a known password). Google now proves the CURRENT
      // user owns the email, so activate it — but first WIPE the pre-seeded password to a random
      // unusable value, neutralising a pre-hijack. setUserPassword + setUserStatus both bump
      // token_version, so any pre-existing session is revoked too. Owner uses Google (or "forgot
      // password" to set their own) going forward.
      await db.setUserPassword(u.id, hashPassword(crypto.randomBytes(32).toString('hex')));
      await db.setUserStatus(u.id, 'active');
      u = await db.getUserById(u.id);
    }
    const expires = Date.now() + SESSION_TTL;
    const token = signSession({ uid: u.id, role: u.role, exp: expires, tokenVersion: u.token_version });
    req.user = { uid: u.id, role: u.role, email: u.email };
    audit(req, 'auth.google', {}).catch(() => {});
    return res.json({ token, expiresAt: new Date(expires).toISOString(), user: { email: u.email, role: u.role } });
  } catch (e) {
    log('error', 'google_auth_error', { error: e.message });
    return res.status(500).json({ error: 'Ошибка входа через Google' });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  try {
    await db.revokeUserSessions(req.user.uid);
    audit(req, 'auth.logout', {}).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.get('/api/auth/check', requireAuth, (req, res) => {
  res.json({ ok: true, role: req.user.role, email: req.user.email });
});

app.get('/api/auth/me', requireAuth, asyncHandler(async (req, res) => {
  let avatar = null;
  if (db.enabled) {
    avatar = await db.getUserAvatar(req.user.uid).catch(() => null);
  }
  res.json({ uid: req.user.uid, email: req.user.email, role: req.user.role, avatar });
}));

// Personal avatar — a small base64 data URL on the user row (resized client-side). Own-route JSON
// limit — the global 100kb parser skips this path (see the jsonSmall skip-list above), so this
// 1mb parser is the one that runs; the regex + length cap keep a giant payload out of the DB.
app.post('/api/me/avatar', requireAuth, express.json({ limit: '1mb' }), async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const dataUrl = req.body && req.body.dataUrl;
  if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
    return res.status(400).json({ error: 'Нужен PNG, JPEG или WebP' });
  }
  if (dataUrl.length > 400000) return res.status(413).json({ error: 'Слишком большое изображение (до ~280 КБ)' });
  try {
    await db.setUserAvatar(req.user.uid, dataUrl);
    res.json({ ok: true, avatar: dataUrl });
  } catch (e) { next(e); }
});
app.delete('/api/me/avatar', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  try {
    await db.setUserAvatar(req.user.uid, null);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Email verification. GET serves an interstitial that does NOT consume the token —
// link-prefetchers (Outlook SafeLinks, AV scanners) issue GETs and a single-use
// token must survive that. The explicit button POSTs to consume + activate.
app.get('/api/auth/verify', (req, res) => {
  const tokenJs = JSON.stringify(String(req.query.token || '')).replace(/</g, '\\u003c');  // safe embed
  res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer')
    .send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подтверждение email</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;background:#e5edf5;color:#061b31;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.c{background:#fff;padding:32px;border-radius:8px;max-width:380px;text-align:center;box-shadow:0 4px 24px rgba(6,27,49,.08)}button{margin-top:18px;padding:11px 22px;background:#533afd;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer}.m{margin-top:14px;font-size:13px;color:#64748d}</style></head>
<body><div class="c"><h2>Подтверждение email</h2><p>Активируй аккаунт в Atlavue.</p><button id="b">Подтвердить email</button><div class="m" id="m"></div></div>
<script>var t=${tokenJs};document.getElementById('b').onclick=function(){var b=this;b.disabled=true;b.textContent='…';fetch('/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})}).then(function(r){return r.json().catch(function(){return{}})}).then(function(j){if(j&&j.ok){location.href='/?verified=1';}else{document.getElementById('m').textContent=(j&&j.error)||'Ссылка недействительна или истекла';b.style.display='none';}}).catch(function(){document.getElementById('m').textContent='Ошибка сети';b.disabled=false;b.textContent='Подтвердить email';});};</script></body></html>`);
});

app.post('/api/auth/verify', authLimiter, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const raw = String((req.body && req.body.token) || '');
  if (!raw) return res.status(400).json({ error: 'Ссылка недействительна' });
  try {
    const t = await db.useEmailToken(sha256(raw), 'verify');
    if (!t) return res.status(400).json({ error: 'Ссылка недействительна или истекла' });
    const u = await db.getUserById(t.uid);
    if (u && u.status === 'unverified') {
      await db.setUserStatus(t.uid, 'active');
      req.user = { uid: t.uid };                    // attribute the audit event (route is unauthenticated)
      audit(req, 'auth.verified', {}).catch(() => {});
      return res.json({ ok: true });
    }
    if (u && u.status === 'active') return res.json({ ok: true });             // already verified — idempotent
    return res.status(400).json({ error: 'Аккаунт нельзя активировать' });     // disabled/pending: NOT via verify
  } catch (e) { next(e); }
});

// Password reset request — always generic (no account enumeration).
app.post('/api/auth/forgot', authLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  res.json({ ok: true, message: 'Если такой аккаунт есть — мы отправили ссылку для сброса.' });   // respond first
  if (!db.enabled || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
  try {
    const base = appBase(req);
    const u = await db.getUserByEmail(email);
    if (u && u.status !== 'disabled') {
      const raw = newToken();
      const id = await db.createEmailToken(u.id, 'reset', sha256(raw), new Date(Date.now() + RESET_TTL));
      const link = `${base}/reset?token=${raw}`;
      if (id) await sendEmail(email, 'Сброс пароля — Atlavue', resetEmailHtml(link), link);
    }
  } catch (e) { console.error('[forgot]', e.message); }   // already responded generically
});

// Password reset — consume token, set new password. Only promotes 'unverified'→'active'
// (a reset proves email ownership); never re-activates a disabled/pending account.
app.post('/api/auth/reset', authLimiter, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const raw = String((req.body && req.body.token) || '');
  const password = String((req.body && req.body.password) || '');
  if (password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });
  if (!raw) return res.status(400).json({ error: 'Ссылка недействительна' });
  try {
    const t = await db.useEmailToken(sha256(raw), 'reset');
    if (!t) return res.status(400).json({ error: 'Ссылка недействительна или истекла' });
    await db.setUserPassword(t.uid, hashPassword(password));
    const u = await db.getUserById(t.uid);
    if (u && u.status === 'unverified') await db.setUserStatus(t.uid, 'active');
    req.user = { uid: t.uid };                      // attribute the audit event (route is unauthenticated)
    audit(req, 'auth.reset', {}).catch(() => {});
    res.json({ ok: true, message: 'Пароль обновлён — войди с новым паролем.' });
  } catch (e) { next(e); }
});

// Resend verification email (generic; only acts for an 'unverified' account).
app.post('/api/auth/resend-verification', authLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  res.json({ ok: true, message: 'Если аккаунт ждёт подтверждения — письмо отправлено снова.' });   // respond first
  if (!db.enabled) return;
  try {
    const base = appBase(req);
    const u = await db.getUserByEmail(email);
    if (u && u.status === 'unverified') {
      const raw = newToken();
      const id = await db.createEmailToken(u.id, 'verify', sha256(raw), new Date(Date.now() + VERIFY_TTL));
      const link = `${base}/verify?token=${raw}`;
      if (id) await sendEmail(email, 'Подтверди email — Atlavue', verifyEmailHtml(link), link);
    }
  } catch (e) { console.error('[resend]', e.message); }
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

app.post('/api/auth/change-password', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const cur = String((req.body && req.body.current) || '');
  const nextPass = String((req.body && req.body.next) || '');   // don't shadow next()
  if (nextPass.length < 8) return res.status(400).json({ error: 'Новый пароль минимум 8 символов' });
  try {
    const u = await db.getUserByEmail(req.user.email);
    if (!u || !verifyPassword(cur, u.pass_hash)) return res.status(403).json({ error: 'Текущий пароль неверен' });
    await db.setUserPassword(u.id, hashPassword(nextPass));
    audit(req, 'auth.password_changed', {}).catch(() => {});
    res.json({ ok: true });
  } catch (e) { next(e); }
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
const IG_CLIENT_ID     = process.env.IG_CLIENT_ID;
const IG_CLIENT_SECRET = process.env.IG_CLIENT_SECRET;
// Insights edges (reach / views / follower_count / follows_and_unfollows, media & story insights)
// require instagram_business_manage_insights — instagram_business_basic alone is NOT enough. Both
// are requested at connect time (Meta blog 2025-03-24).
const IG_OAUTH_SCOPES  = 'instagram_business_basic,instagram_business_manage_insights';
const igCrypto     = require('./lib/ig_crypto');
const tgCrypto     = require('./lib/tg_crypto');
const igMock       = require('./ig_mock');
// Global env single-account is "configured" when both token + account id are present.
const igConfigured = () => !!IG_TOKEN && !!IG_ACCOUNT;
// The per-channel OAuth connect flow needs app credentials, the token-encryption key, and a DB
// (tokens are stored encrypted, one per channel). Without all three, connect is unavailable and
// IG falls back to the global env account (or mock).
const igOauthConfigured = () => !!IG_CLIENT_ID && !!IG_CLIENT_SECRET && igCrypto.configured() && db.enabled;

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

// Drop cached IG payloads for one account id (keys look like `ig:<kind>:<accountId>[:...]`),
// so a connect/disconnect flips the UI immediately instead of waiting out the 10-min TTL.
function igCachePurge(accountId) {
  if (!accountId) return;
  const id = String(accountId);
  // Delimiter-aware: match the account id as a whole ':'-segment, so purging id 123 never touches
  // 1234's keys (a substring `includes(':123')` would). Keys look like ig:<kind>:<accountId>[:<param>].
  for (const k of cache.keys()) if (k.startsWith('ig:') && k.split(':').includes(id)) cache.delete(k);
}

// OAuth "state": a signed, expiring blob binding the connect flow to (uid, channelId). The
// callback lands WITHOUT a session header (top-level browser redirect from Instagram), so the
// signed state is the only trustworthy attribution — HMAC(IG_STATE_KEY, a domain-separated
// subkey of AUTH_SECRET) + 10-min expiry + nonce.
const IG_STATE_TTL = 10 * 60 * 1000;
function signIgState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', IG_STATE_KEY).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function parseIgState(state) {
  try {
    if (!state || typeof state !== 'string' || state.indexOf('.') < 0) return null;
    const [body, sig] = state.split('.');
    const expected = crypto.createHmac('sha256', IG_STATE_KEY).update(body).digest('base64url');
    if (!sig || sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp <= Date.now()) return null;
    return payload;
  } catch { return null; }
}

// GET /api/ig/profile — профиль аккаунта (теперь с аватаркой)
app.get('/api/ig/profile', requireAuth, resolveIg, async (req, res, next) => {
  try {
    if (!req.ig) return res.json(igMock.igMockProfile());
    const cacheKey = `ig:profile:${req.ig.accountId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    if (!consumeSourceRefreshQuota(req, res)) return;

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
    const cacheKey = `ig:tags:${req.ig.accountId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    if (!consumeSourceRefreshQuota(req, res)) return;

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
    const result = { data, live_count: live.length };
    cacheSet(cacheKey, result);
    res.json(result);
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
    if (!consumeSourceRefreshQuota(req, res)) return;

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
    const [dailyR, curR, prevR, fauCurR, fauPrevR] = await Promise.all([
      dailyCall.catch(() => null),
      fetchTv(curSince, curUntil),
      fetchTv(prevSince, prevUntil),
      fetchFau(curSince, curUntil).catch(() => null),
      fetchFau(prevSince, prevUntil).catch(() => null),
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
    if (!consumeSourceRefreshQuota(req, res)) return;

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
    if (!consumeSourceRefreshQuota(req, res)) return;
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
    if (!consumeSourceRefreshQuota(req, res)) return;
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
    if (!consumeSourceRefreshQuota(req, res)) return;
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
  // follows_and_unfollows → follows / unfollows.
  try {
    const fau = await igFetch(`/${id}/insights`, { metric: 'follows_and_unfollows', metric_type: 'total_value', breakdown: 'follow_type', period: 'day', since, until }, token);
    const { follows, unfollows } = igFauVal(fau);
    row.follows = igNum(follows); row.unfollows = igNum(unfollows);
  } catch (e) { log('warn', 'ig_cron_fau_failed', { channelId: acc.channel_id, error: e.message }); }
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
// fire-and-forget after the central ingest; sequential + per-channel try/catch so one bad session /
// channel / FloodWait never blocks the others or the critical central ingest. Sessions are decrypted
// ONLY here and handed to the isolated mtproto /qr/collect — never logged, never sent to a client.
const TG_QR_MAX_CHANNELS_PER_RUN = 200;

async function processTgQrCollection() {
  if (!db.enabled || !tgCrypto.configured() || !MTPROTO_TOKEN) return;
  const day = new Date().toISOString().slice(0, 10);
  let sessions = [];
  try { sessions = await db.listTgSessions(); }
  catch (e) { log('error', 'tg_qr_list_sessions_failed', { error: e.message }); return; }

  let done = 0, capped = false;
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
      done++;
      try { await collectQrChannel(sessionStr, ch, day); }
      catch (e) { log('error', 'tg_qr_collect_failed', { channelId: ch.id, error: e.message }); }
    }
  }
  if (capped) log('warn', 'tg_qr_collection_capped', { cap: TG_QR_MAX_CHANNELS_PER_RUN, sessions: sessions.length });
}

// ── Instagram OAuth (per-channel connect) ─────────────────────────
// "Business Login for Instagram" (Instagram API with Instagram Login, no Facebook Page).
// Flow: start (authed, returns authorize_url) → user authorizes on instagram.com → callback
// (credential-free, trusts the signed state) → code→short→long-lived token → stored encrypted
// against the channel. Inert until IG_CLIENT_ID/IG_CLIENT_SECRET/IG_TOKEN_KEY + a DB are set.

// POST /api/ig/oauth/start — begin connecting an Instagram account to the selected channel.
// Returns { authorize_url } for a top-level browser navigation (a session header can't survive
// the OAuth redirect, so we can't 302 here). The (uid, channelId) are bound into a signed state.
app.post('/api/ig/oauth/start', requireAuth, asyncHandler(async (req, res) => {
  if (!igOauthConfigured()) return res.status(400).json({ error: 'Подключение Instagram не настроено на сервере' });
  // ?new_source=1 — connect the account as its OWN standalone source (a fresh channels row is
  // created in the callback once the identity is known) instead of attaching it to a channel.
  const newSource = String(req.query.new_source || '') === '1';
  const channelId = newSource ? 0 : parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
  if (!newSource) {
    if (!channelId) return res.status(400).json({ error: 'Выбери канал, к которому подключить Instagram' });
    const ch = await db.getChannel(channelId, req.user).catch(() => null);
    if (!ch) return res.status(403).json({ error: 'Нет доступа к этому каналу' });
    // Rebinding the channel's IG account/token — workspace admins only (ADR-001). The callback
    // trusts the signed state, so gating the state mint here covers the whole flow.
    if (!hasWorkspaceRole(ch, req.user, 'admin')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
  }
  const state = signIgState({ uid: req.user.uid, channelId, ns: newSource ? 1 : 0, nonce: crypto.randomBytes(12).toString('base64url'), exp: Date.now() + IG_STATE_TTL });
  const authorizeUrl = 'https://www.instagram.com/oauth/authorize?' + new URLSearchParams({
    client_id: IG_CLIENT_ID,
    redirect_uri: `${appBase(req)}/api/ig/oauth/callback`,
    response_type: 'code',
    scope: IG_OAUTH_SCOPES,
    state,
  }).toString();
  await audit(req, 'ig_oauth_start', { channelId });
  res.json({ authorize_url: authorizeUrl });
}));

// GET /api/ig/oauth/callback — Instagram redirects the user's browser here after they authorize.
// No session header (top-level redirect), so trust comes from the signed state. Exchanges the code
// for a long-lived token, stores it encrypted against the channel, then bounces the browser back
// into the SPA with a success/error flag. Never renders tokens; logs stay secret-free.
app.get('/api/ig/oauth/callback', async (req, res) => {
  const back = (q) => res.redirect(302, `${appBase(req)}/instagram?${q}`);
  try {
    if (req.query.error) return back('ig_error=denied');
    if (!igOauthConfigured()) return back('ig_error=server');
    const st = parseIgState(req.query.state);
    const code = String(req.query.code || '');
    if (!st || !code) return back('ig_error=state');

    // Re-verify the user still exists/active and still owns the target channel (state can outlive
    // a permission change).
    if (st.uid == null) return back('ig_error=auth');
    const u = await db.getUserById(st.uid).catch(() => null);
    if (!u || u.status !== 'active') return back('ig_error=auth');
    const user = { uid: u.id, role: u.role, email: u.email };
    // Channel-bound connect re-verifies ownership; a new-source connect has no channel yet —
    // its row is created below, after the Instagram identity is known.
    if (!st.ns) {
      const ch = await db.getChannel(st.channelId, user).catch(() => null);
      if (!ch) return back('ig_error=channel');
    }
    const redirectUri = `${appBase(req)}/api/ig/oauth/callback`;

    // 1) authorization code → short-lived token (api.instagram.com, form-encoded POST).
    const shortRes = await fetchWithTimeout('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: IG_CLIENT_ID,
        client_secret: IG_CLIENT_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }).toString(),
    });
    const shortJson = await shortRes.json().catch(() => ({}));
    if (!shortJson.access_token) {
      log('warn', 'ig_oauth_short_failed', { channelId: st.channelId, err: shortJson.error_message || shortJson.error_type || 'no_token' });
      return back('ig_error=exchange');
    }

    // 2) short-lived → long-lived (~60d) token (graph.instagram.com). If this fails we must NOT
    // silently persist the 1-hour short token under a 60-day expiry (the connection would die in an
    // hour with no refresh path) — bail with an error flag and let the user retry.
    const longRes = await fetchWithTimeout(`${IG_GRAPH}/access_token?` + new URLSearchParams({
      grant_type: 'ig_exchange_token', client_secret: IG_CLIENT_SECRET, access_token: shortJson.access_token }).toString());
    const longJson = await longRes.json().catch(() => ({}));
    if (!longJson.access_token || !longJson.expires_in) {
      log('warn', 'ig_oauth_long_failed', { channelId: st.channelId, err: longJson.error_message || (longJson.error && longJson.error.message) || longJson.error || 'no_long_token' });
      return back('ig_error=exchange');
    }
    const longToken = longJson.access_token;
    const expiresIn = Number(longJson.expires_in);

    // 3) identity — the IG user id + username to display and to build data-edge paths.
    const meRes = await fetchWithTimeout(`${IG_GRAPH}/me?` + new URLSearchParams({ fields: 'id,username,account_type', access_token: longToken }).toString());
    const me = await meRes.json().catch(() => ({}));
    const igUserId = me.id || String(shortJson.user_id || '');
    if (!igUserId) return back('ig_error=identity');

    // New-source connect: reuse the user's channel that already holds this identity (a
    // reconnect just refreshes its token), else create a standalone source='ig' row.
    let targetChannelId = st.channelId;
    if (st.ns) {
      const existing = await db.findIgChannelByIgUser(user.uid, igUserId).catch(() => null);
      if (existing) {
        targetChannelId = existing;
      } else {
        const created = await db.createIgChannel({ owner_uid: user.uid, username: me.username || null }).catch(() => null);
        if (!created) return back('ig_error=channel');
        targetChannelId = created.id;
      }
    }

    await db.saveIgAccount(targetChannelId, {
      ig_user_id: igUserId,
      username: me.username || null,
      access_token_enc: igCrypto.encrypt(longToken),
      token_expires_at: new Date(Date.now() + expiresIn * 1000),
      scopes: IG_OAUTH_SCOPES,
    });
    igCachePurge(igUserId);   // clear any stale cached payloads for this account id
    req.user = user; req.channel = { id: targetChannelId };
    await audit(req, 'ig_oauth_connected', { channelId: targetChannelId, username: me.username || null, newSource: !!st.ns });
    // ch= lets the SPA switch straight to the (possibly fresh) source after the bounce.
    return back(`ig=connected&ch=${targetChannelId}`);
  } catch (e) {
    log('error', 'ig_oauth_callback_error', { error: e.message });
    return back('ig_error=exchange');
  }
});

// DELETE /api/ig/oauth — disconnect the Instagram account from the selected channel.
app.delete('/api/ig/oauth', requireAuth, asyncHandler(async (req, res) => {
  const channelId = parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
  if (!channelId) return res.status(400).json({ error: 'Канал не выбран' });
  const ch = await db.getChannel(channelId, req.user).catch(() => null);
  if (!ch) return res.status(403).json({ error: 'Нет доступа к этому каналу' });
  if (!hasWorkspaceRole(ch, req.user, 'admin')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
  const acc = await db.getIgAccount(channelId).catch(() => null);
  const removed = await db.deleteIgAccount(channelId);
  if (acc && acc.ig_user_id) igCachePurge(acc.ig_user_id);
  await audit(req, 'ig_oauth_disconnected', { channelId });
  res.json({ ok: true, removed });
}));

// GET /api/ig/oauth/status — connection state for Settings + the connect panel (no token leaked).
app.get('/api/ig/oauth/status', requireAuth, asyncHandler(async (req, res) => {
  const channelId = parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
  let acc = null;
  if (db.enabled && channelId) {
    const ch = await db.getChannel(channelId, req.user).catch(() => null);
    if (ch) acc = await db.getIgAccount(channelId).catch(() => null);
  }
  res.json({
    server_ready: igOauthConfigured(),   // app credentials + encryption key + DB all present
    env_fallback: igConfigured(),        // a global env account is serving IG in the meantime
    connected: !!acc,
    channel_id: channelId || null,
    username: acc ? acc.username : null,
    ig_user_id: acc ? acc.ig_user_id : null,
    connected_at: acc ? acc.connected_at : null,
    token_expires_at: acc ? acc.token_expires_at : null,
  });
}));

// ════════════════════════════════════════════════════════════════
//  TELEGRAM — Bot API
// ════════════════════════════════════════════════════════════════

const TG_BASE    = 'https://api.telegram.org/bot';
const TG_TOKEN   = process.env.TG_BOT_TOKEN;
const TG_CHANNEL = process.env.TG_CHANNEL;

async function tgFetch(method, params = {}) {
  const url = new URL(`${TG_BASE}${TG_TOKEN}/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res  = await fetchWithTimeout(url.toString());
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram API: ${json.description}`);
  return json.result;
}

// Channels (tenants) the user owns — drives the dashboard channel switcher.
// No DB → one synthetic 'central' channel (id 0) so the legacy single-channel
// dashboard still works locally without Postgres.
app.get('/api/channels', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.json({ enabled: false, channels: [{ id: 0, username: '', title: '', source: 'central' }], selected: 0 });
  if (!dbReady) return res.status(503).json({ error: 'Сервис запускается' });
  try {
    const channels = await db.listChannels(req.user);
    res.json({ enabled: true, channels, selected: channels[0] ? channels[0].id : null });
  } catch (e) { next(e); }
});

// Create a channel (self-serve).
app.post('/api/channels', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const username = String((req.body && req.body.username) || '').replace(/^@/, '').trim();
  const title = String((req.body && req.body.title) || '').trim().slice(0, 120);
  if (!/^[a-zA-Z0-9_]{3,64}$/.test(username)) return res.status(400).json({ error: 'Некорректный @username канала' });
  try {
    const mine = await db.listChannels(req.user);
      if (mine.length >= 20) return res.status(409).json({ error: 'Достигнут лимит каналов' });   // soft cap; tiers in Sprint 2
      const channel = await db.createChannel({ owner_uid: req.user.uid, username, title });
      req.channel = channel;
      audit(req, 'channel.created', { username }).catch(() => {});
      res.json(channel);
  } catch (e) { next(e); }
});

app.delete('/api/channels/:id', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const ok = await db.deleteChannel(id, req.user.uid);
    if (ok) audit(req, 'channel.deleted', { channel_id: id }).catch(() => {});
    res.json({ ok });
  }
  catch (e) { next(e); }
});

// Generate an API key for a channel the user owns — the raw key is shown ONCE.
app.post('/api/channels/:id/key', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const ch = await db.getChannel(id, req.user);
    if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
    // A collector key is a standing data-write credential — workspace admins only (ADR-001).
    if (!hasWorkspaceRole(ch, req.user, 'admin')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
    if (ch.source === 'central') return res.status(400).json({ error: 'central-канал не использует collector-ключи' });
      const raw = 'pa_' + crypto.randomBytes(24).toString('base64url');
      const rec = await db.createApiKey(id, sha256(raw), raw.slice(0, 11), String((req.body && req.body.label) || '').slice(0, 60) || null);
      req.channel = ch;
      audit(req, 'api_key.created', { key_id: rec.id, key_prefix: rec.key_prefix }).catch(() => {});
      res.json({ ...rec, key: raw });   // raw key — never stored, shown once
  } catch (e) { next(e); }
});

app.get('/api/channels/:id/keys', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.json({ keys: [] });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const ch = await db.getChannel(id, req.user);
    if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
    if (!hasWorkspaceRole(ch, req.user, 'admin')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
    res.json({ keys: await db.listApiKeys(id, req.user.uid) });
  }
  catch (e) { next(e); }
});

app.delete('/api/channels/:id/key/:keyId', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  const keyId = parseInt(req.params.keyId, 10);
  if (!id || !keyId) return res.status(400).json({ error: 'bad id' });
  try {
    const ch = await db.getChannel(id, req.user);
    if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
    if (!hasWorkspaceRole(ch, req.user, 'admin')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
    const ok = await db.revokeApiKey(keyId, id, req.user.uid);
    if (ok) audit(req, 'api_key.revoked', { key_id: keyId }).catch(() => {});
    res.json({ ok });
  }
  catch (e) { next(e); }
});

// ── Timeline annotations (F1): per-channel event markers on the trend charts ──
app.get('/api/channels/:id/annotations', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.json({ annotations: [] });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const ch = await db.getChannel(id, req.user);
    if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
    res.json({ annotations: await db.listAnnotations(id) });
  } catch (e) { next(e); }
});

app.post('/api/channels/:id/annotations', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  const day = String((req.body && req.body.day) || '').trim();
  const label = String((req.body && req.body.label) || '').trim();
  if (!id) return res.status(400).json({ error: 'bad id' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'day = YYYY-MM-DD' });
  if (!label) return res.status(400).json({ error: 'label обязателен' });
  try {
    const ch = await db.getChannel(id, req.user);
    if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
    if (!hasWorkspaceRole(ch, req.user, 'member')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
    const rec = await db.createAnnotation(id, { day, label: label.slice(0, 120), createdBy: req.user.uid });
    audit(req, 'annotation.created', { channel_id: id, annotation_id: rec && rec.id }).catch(() => {});
    res.json(rec);
  } catch (e) { next(e); }
});

app.delete('/api/channels/:id/annotations/:annId', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  const annId = parseInt(req.params.annId, 10);
  if (!id || !annId) return res.status(400).json({ error: 'bad id' });
  try {
    const ch = await db.getChannel(id, req.user);
    if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
    if (!hasWorkspaceRole(ch, req.user, 'member')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
    const ok = await db.deleteAnnotation(annId, id);
    if (ok) audit(req, 'annotation.deleted', { channel_id: id, annotation_id: annId }).catch(() => {});
    res.json({ ok });
  } catch (e) { next(e); }
});

// ── Именованные отчёты: сохранённые композиции блоков дашборда (+ email-выгрузка) ──
// config — произвольная композиция блоков, целиком принадлежит фронту; сервер
// проверяет только форму (plain object) и размер сериализованного JSON.
const REPORT_CONFIG_MAX_CHARS = 16000;
const REPORT_MAX_BLOCKS = 100;
function reportConfigError(config) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return 'config должен быть объектом';
  // Blocks stay frontend-owned (generic { id, type, config } or legacy string keys); the server
  // only checks the coarse shape so a broken client can't persist garbage: an array of strings or
  // plain objects, capped in count. The 16 KB serialized cap below still bounds everything else.
  if (config.blocks !== undefined) {
    if (!Array.isArray(config.blocks)) return 'config.blocks должен быть массивом';
    if (config.blocks.length > REPORT_MAX_BLOCKS) return `config.blocks: слишком много блоков (макс. ${REPORT_MAX_BLOCKS})`;
    for (const b of config.blocks) {
      const t = typeof b;
      if (t !== 'string' && (t !== 'object' || b === null || Array.isArray(b))) {
        return 'config.blocks: элемент должен быть строкой или объектом';
      }
    }
  }
  if (JSON.stringify(config).length > REPORT_CONFIG_MAX_CHARS) return `config слишком большой (макс. ${REPORT_CONFIG_MAX_CHARS} символов JSON)`;
  return null;
}
const REPORTS_DB_OFF = { error: 'БД не подключена — отчёты недоступны' };

app.get('/api/reports', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json(REPORTS_DB_OFF);
  try { res.json({ reports: await db.listReports(req.user.uid) }); }
  catch (e) { next(e); }
});

app.post('/api/reports', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json(REPORTS_DB_OFF);
  const name = String((req.body && req.body.name) || '').trim();
  if (!name || name.length > 120) return res.status(400).json({ error: 'name: от 1 до 120 символов' });
  const config = (req.body && req.body.config !== undefined) ? req.body.config : {};
  const bad = reportConfigError(config);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const report = await db.createReport(req.user.uid, name, config);
    audit(req, 'report.created', { report_id: report && report.id }).catch(() => {});
    res.json({ report });
  } catch (e) { next(e); }
});

app.get('/api/reports/:id', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json(REPORTS_DB_OFF);
  // Full-match digits + a length cap: parseInt would accept '123abc', and anything
  // past 9 digits risks overflowing the int4 id column in Postgres.
  if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const id = Number(req.params.id);
  try {
    const report = await db.getReport(req.user.uid, id);
    if (!report) return res.status(404).json({ error: 'Отчёт не найден' });
    res.json({ report });
  } catch (e) { next(e); }
});

app.put('/api/reports/:id', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json(REPORTS_DB_OFF);
  // Full-match digits + a length cap: parseInt would accept '123abc', and anything
  // past 9 digits risks overflowing the int4 id column in Postgres.
  if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const id = Number(req.params.id);
  const body = req.body || {};
  const patch = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'name: от 1 до 120 символов' });
    patch.name = name;
  }
  if (body.config !== undefined) {
    const bad = reportConfigError(body.config);
    if (bad) return res.status(400).json({ error: bad });
    patch.config = body.config;
  }
  if (body.schedule !== undefined) {
    if (!db.REPORT_SCHEDULES.includes(body.schedule)) return res.status(400).json({ error: 'schedule: none | weekly | monthly' });
    patch.schedule = body.schedule;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Нечего обновлять: нужен name, config или schedule' });
  try {
    const report = await db.updateReport(req.user.uid, id, patch);
    if (!report) return res.status(404).json({ error: 'Отчёт не найден' });
    audit(req, 'report.updated', { report_id: id, fields: Object.keys(patch) }).catch(() => {});
    res.json({ report });
  } catch (e) { next(e); }
});

app.delete('/api/reports/:id', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json(REPORTS_DB_OFF);
  // Full-match digits + a length cap: parseInt would accept '123abc', and anything
  // past 9 digits risks overflowing the int4 id column in Postgres.
  if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const id = Number(req.params.id);
  try {
    const ok = await db.deleteReport(req.user.uid, id);
    if (!ok) return res.status(404).json({ error: 'Отчёт не найден' });
    audit(req, 'report.deleted', { report_id: id }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* Email-выгрузка отчётов (v1). Дёргается fire-and-forget из дневного ingest-крона
   (единственный ежедневный тик системы — отдельного планировщика нет): weekly уходит
   в понедельник UTC, monthly — 1-го числа UTC. Если крон в «свой» день не сработал,
   действует catch-up: weekly шлётся, когда last_sent_at старше 8 дней, monthly — 32
   дней (первая отправка якорится к понедельнику / 1-му). Окно по last_sent_at в
   listDueReports остаётся анти-дублем, если крон сработал дважды за день. Все ошибки
   логируются и никогда не влияют на ответ ingest-а. */
const reportEmailHtml = (base, report) => emailShell(`Отчёт „${escHtml(report.name)}“`,
  `<p>Ваш регулярный отчёт Atlavue готов:</p>${emailBtn(`${base}/reports/${report.id}`, 'Открыть отчёт')}` +
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
        const ok = await sendEmail(r.email, `Atlavue — отчёт „${r.name}“`, reportEmailHtml(base, r));
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

app.get('/api/tg/channel', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
  if (await serveSnapshot(req, res, d => d.channel)) return;
  const cacheKey = `tg:channel:${req.channel.id}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Основной источник — Bot API (только если задан токен бота)
    if (TG_TOKEN) {
      try {
        const [chat, memberCount] = await Promise.all([
          tgFetch('getChat',            { chat_id: TG_CHANNEL }),
          tgFetch('getChatMemberCount', { chat_id: TG_CHANNEL })
        ]);
        const data = {
          id:          chat.id,
          title:       chat.title,
          username:    chat.username,
          description: chat.description || '',
          memberCount,
          online:      0,
          inviteLink:  chat.invite_link || null,
          source:      'bot_api',
        };
        cacheSet(cacheKey, data);
        return res.json(data);
      } catch (_botErr) {
        // бот недоступен → падаем в MTProto-фолбэк ниже
      }
    }

    // Фолбэк — MTProto через твой личный аккаунт (работает без бота)
    const mt = await mtprotoFetch('/channel');
    const data = {
      id:          mt.id,
      title:       mt.title,
      username:    mt.username,
      description: mt.description || '',
      memberCount: mt.members || 0,
      online:      mt.online || 0,
      inviteLink:  null,
      source:      'mtproto',
    };
    if (req.channel.id && mt.id) db.setChannelTgId(req.channel.id, mt.id).catch(() => {});   // populate tg_channel_id once
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    // both sources failed (bot errors fall through to MTProto above) → upstream outage
    res.status(503).json({ error: e.message, hint: 'MTProto сервис недоступен' });
  }
}));

// ════════════════════════════════════════════════════════════════
//  TELEGRAM — MTProto прокси
// ════════════════════════════════════════════════════════════════

const MTPROTO_URL  = process.env.MTPROTO_URL || 'http://localhost:8001';
// Dedicated web→mtproto internal secret; the SAME value must be set as
// MTPROTO_TOKEN on the mtproto service (which fails closed when unset).
// Presence is enforced at boot in production when MTPROTO_URL is configured.
const MTPROTO_TOKEN = process.env.MTPROTO_TOKEN || '';
// Heavy Telethon endpoints (stats graphs, velocity, mentions) are serialized on the
// Python side and can legitimately take minutes when queued — they get a long
// deadline; everything else fails fast with the default.
const MTPROTO_TIMEOUT_MS       = 12000;
const MTPROTO_TIMEOUT_STATS_MS = 60000;
const MTPROTO_TIMEOUT_HEAVY_MS = 120000;

async function mtprotoFetch(path, params = {}, timeoutMs = MTPROTO_TIMEOUT_MS) {
  const url = new URL(MTPROTO_URL + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res  = await fetchWithTimeout(url.toString(), {
    headers: { 'x-internal-token': MTPROTO_TOKEN }
  }, timeoutMs);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    if (res.status === 429) {
      // Telethon FloodWait mapped by the Python side: an expected throttle, not an
      // outage. Surface as 503-with-message so the dashboard shows "retry later".
      const e = new Error('Telegram временно ограничил запросы' + (err.retry_after ? ` — повтори через ~${err.retry_after} с` : ''));
      e.status = 503;
      if (err.retry_after) e.retryAfter = err.retry_after;
      throw e;
    }
    throw new Error(err.detail || `MTProto error ${res.status}`);
  }
  return res.json();
}

// POST variant for the QR-login handshake (start/poll/password/cancel).
async function mtprotoPost(path, { params = {}, body = undefined, timeoutMs = MTPROTO_TIMEOUT_MS } = {}) {
  const url = new URL(MTPROTO_URL + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetchWithTimeout(url.toString(), {
    method: 'POST',
    headers: { 'x-internal-token': MTPROTO_TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, timeoutMs);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    if (res.status === 429) {
      const e = new Error('Telegram временно ограничил запросы' + (err.retry_after ? ` — повтори через ~${err.retry_after} с` : ''));
      e.status = 503;
      if (err.retry_after) e.retryAfter = err.retry_after;
      throw e;
    }
    throw new Error(err.detail || `MTProto error ${res.status}`);
  }
  return res.json();
}

// ── Telegram QR connect (managed sessions) ───────────────────────────────
// «Scan → done» via MTProto QR login on the Telethon service. The session string it
// returns is encrypted (TG_SESSION_KEY) and stored server-side; it is NEVER sent to the
// browser. Configured only when the mtproto link + encryption key + DB are all present.
function tgQrConfigured() {
  return !!MTPROTO_TOKEN && tgCrypto.configured() && db.enabled;
}

// On a completed login: encrypt + persist the session, then hand the browser only the
// username + the admin channels found (never the session itself).
async function tgQrFinish(req, data) {
  const session_enc = tgCrypto.encrypt(data.session);
  await db.saveTgSession(req.user.uid, { tg_user_id: data.tg_user_id, username: data.username, session_enc });
  audit(req, 'tg.session.connected', { username: data.username || null }).catch(() => {});
  return {
    status: 'ok',
    username: data.username ?? null,
    channels: (Array.isArray(data.channels) ? data.channels : []).map((c) => ({
      id: c.id, title: c.title || '', username: c.username ?? null,
      broadcast: c.broadcast ?? undefined, megagroup: c.megagroup ?? undefined,
      creator: c.creator ?? undefined, participants: c.participants ?? null,
      eligible: c.eligible ?? undefined,
    })),
  };
}

app.get('/api/tg/qr/status', requireAuth, async (req, res, next) => {
  try {
    if (!tgQrConfigured()) return res.json({ server_ready: false, connected: false });
    const s = await db.getTgSession(req.user.uid);
    res.json({ server_ready: true, connected: !!s, username: (s && s.username) || null, connected_at: (s && s.connected_at) || null });
  } catch (e) { next(e); }
});

// Bind each QR login id to the uid that started it — a leaked/guessed id must never let
// another account claim the captured session. In-memory (single web instance) with a TTL; a
// lost binding (server restart) just makes the client's poll read 'expired' and start fresh.
const _qrStarts = new Map(); // id -> { uid, at }
const _QR_START_TTL_MS = 5 * 60 * 1000;
function _qrOwns(id, uid) {
  const o = _qrStarts.get(id);
  return !!o && o.uid === uid;
}

app.post('/api/tg/qr/start', requireAuth, async (req, res, next) => {
  if (!tgQrConfigured()) return res.status(400).json({ error: 'Подключение Telegram по QR не настроено на сервере' });
  try {
    const now = Date.now();
    for (const [k, v] of _qrStarts) if (now - v.at > _QR_START_TTL_MS) _qrStarts.delete(k);
    // One live login per user: cancel any prior pending start before opening a new one.
    for (const [k, v] of _qrStarts) {
      if (v.uid === req.user.uid) {
        _qrStarts.delete(k);
        mtprotoPost('/qr/cancel', { params: { id: k } }).catch(() => {});
      }
    }
    const data = await mtprotoPost('/qr/start');
    _qrStarts.set(data.id, { uid: req.user.uid, at: now });
    res.json({ id: data.id, url: data.url, expires_in: data.expires_in });
  } catch (e) { next(e); }
});

app.post('/api/tg/qr/poll', requireAuth, async (req, res, next) => {
  if (!tgQrConfigured()) return res.status(400).json({ error: 'not_configured' });
  const id = String((req.body && req.body.id) || '');
  if (!id) return res.status(400).json({ error: 'id required' });
  if (!_qrOwns(id, req.user.uid)) return res.json({ status: 'expired' });   // not this user's login
  try {
    const data = await mtprotoPost('/qr/poll', { params: { id } });
    if (data.status === 'ok') { _qrStarts.delete(id); return res.json(await tgQrFinish(req, data)); }
    if (data.status === 'expired' || data.status === 'error') _qrStarts.delete(id);
    res.json({ status: data.status, error: data.error });   // pending | password | expired | error
  } catch (e) { next(e); }
});

app.post('/api/tg/qr/password', requireAuth, async (req, res, next) => {
  if (!tgQrConfigured()) return res.status(400).json({ error: 'not_configured' });
  const id = String((req.body && req.body.id) || '');
  const password = String((req.body && req.body.password) || '');
  if (!id || !password) return res.status(400).json({ error: 'id and password required' });
  if (!_qrOwns(id, req.user.uid)) return res.json({ status: 'expired' });
  try {
    const data = await mtprotoPost('/qr/password', { params: { id }, body: { password } });
    if (data.status === 'ok') { _qrStarts.delete(id); return res.json(await tgQrFinish(req, data)); }
    res.json({ status: data.status, error: data.error });
  } catch (e) { next(e); }
});

// Proactively tear down an abandoned pending login (browser navigates away / gives up), so the
// ephemeral Telethon client is reclaimed immediately instead of waiting for the mtproto GC.
app.post('/api/tg/qr/cancel', requireAuth, async (req, res, next) => {
  const id = String((req.body && req.body.id) || '');
  if (!id || !_qrOwns(id, req.user.uid)) return res.json({ ok: true });
  _qrStarts.delete(id);
  try { await mtprotoPost('/qr/cancel', { params: { id } }); } catch { /* best-effort */ }
  res.json({ ok: true });
});

app.delete('/api/tg/qr/session', requireAuth, async (req, res, next) => {
  try {
    const ok = await db.deleteTgSession(req.user.uid);
    if (ok) audit(req, 'tg.session.revoked', {}).catch(() => {});
    res.json({ ok });
  } catch (e) { next(e); }
});

// Persist the admin channels the user ticked as trackable tenants (source='qr'). The list is supplied
// by the browser (the just-scanned admin channels). We can't re-verify admin rights here yet — that
// needs a session-based re-listing (P2.2) — but every row is HARD-scoped to owner_uid=req.user.uid
// and is only ever fed by THAT user's own captured session, so a crafted/ineligible id just creates
// an empty self-owned row Telegram refuses to hand stats for (no cross-tenant reach). Deduped against
// the user's existing channels (central + already-added) by tg id AND @username; idempotent. The
// daily cron (P2.3) does the actual collection.
app.post('/api/tg/qr/channels', requireAuth, async (req, res, next) => {
  if (!db.enabled) return res.status(400).json({ error: 'База данных выключена' });
  try {
    const sess = await db.getTgSession(req.user.uid);
    if (!sess) return res.status(400).json({ error: 'Сначала подключите Telegram по QR' });
    const raw = req.body && Array.isArray(req.body.channels) ? req.body.channels : null;
    if (!raw || !raw.length) return res.status(400).json({ error: 'Не выбрано ни одного канала' });
    if (raw.length > 100) return res.status(400).json({ error: 'Слишком много каналов за раз' });

    // Dedup against ALL of the user's channels (central + any already tracked). listChannels hides
    // disabled rows, so a re-added disabled channel falls through to createTgChannel and reactivates.
    const mine = await db.listChannels(req.user);
    const haveTgIds = new Set(mine.map((c) => (c.tg_channel_id == null ? '' : String(c.tg_channel_id))).filter(Boolean));
    const haveUnames = new Set(mine.map((c) => (c.username ? String(c.username).replace(/^@/, '').toLowerCase() : '')).filter(Boolean));

    let added = 0, skipped = 0;
    const created = [];
    for (const c of raw) {
      const tgId = Number(c && c.id);
      if (!Number.isInteger(tgId) || tgId <= 0) { skipped++; continue; }
      const uname = String((c && c.username) || '').replace(/^@/, '').trim();
      const title = String((c && c.title) || '').slice(0, 200);
      if (haveTgIds.has(String(tgId)) || (uname && haveUnames.has(uname.toLowerCase()))) { skipped++; continue; }
      const row = await db.createTgChannel({
        owner_uid: req.user.uid, tg_channel_id: tgId, username: uname || null, title: title || null,
      });
      if (row) { added++; created.push(row); } else skipped++;
    }
    audit(req, 'tg.qr.channels_added', { added, skipped }).catch(() => {});
    res.json({ ok: true, added, skipped });

    // Fill the just-added channels now, so the dashboard shows data within seconds instead of waiting
    // for the nightly cron. Fire-and-forget AFTER the response — collection latency never blocks it.
    if (created.length) {
      collectQrChannelsNow(sess, created).catch((e) =>
        log('error', 'tg_qr_collect_now_batch_failed', { error: e.message }));
    }
  } catch (e) { next(e); }
});

app.get('/api/tg/mtproto/health', requireAuth, async (req, res) => {
  try {
    const data = await mtprotoFetch('/health');
    res.json({ available: true, ...data });
  } catch (e) {
    res.json({ available: false, error: e.message });
  }
});

app.get('/api/tg/mtproto/channel', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
  if (await serveSnapshot(req, res, d => d.channel)) return;
  const cacheKey = `mtproto:channel:${req.channel.id}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    if (!consumeSourceRefreshQuota(req, res)) return;
    const data = await mtprotoFetch('/channel');
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message, hint: 'MTProto сервис недоступен' });
  }
}));

app.get('/api/tg/mtproto/posts', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
  if (await serveSnapshot(req, res, d => ({ posts: d.posts || [], count: (d.posts || []).length }))) return;
  const limit     = Math.min(100, parseInt(req.query.limit)     || 30);
  const offsetId  = parseInt(req.query.offset_id) || 0;
  const cacheKey  = `mtproto:posts:${req.channel.id}:${limit}:${offsetId}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    if (!consumeSourceRefreshQuota(req, res)) return;
    const data = await mtprotoFetch('/posts', { limit, offset_id: offsetId });
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message, hint: 'MTProto сервис недоступен' });
  }
}));

app.get('/api/tg/mtproto/views_summary', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
  if (await serveSnapshot(req, res, d => d.views_summary)) return;
  const limit    = Math.min(100, parseInt(req.query.limit) || 30);
  const cacheKey = `mtproto:views:${req.channel.id}:${limit}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    if (!consumeSourceRefreshQuota(req, res)) return;
    const data = await mtprotoFetch('/views_summary', { limit }, MTPROTO_TIMEOUT_STATS_MS);
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message, hint: 'MTProto сервис недоступен' });
  }
}));

app.get('/api/tg/mtproto/stats', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
  if (await serveSnapshot(req, res, d => d.stats)) return;
  const cacheKey = `mtproto:stats:${req.channel.id}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    if (!consumeSourceRefreshQuota(req, res)) return;
    const data = await mtprotoFetch('/stats', {}, MTPROTO_TIMEOUT_STATS_MS);
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    // Сюда попадаем только при РЕАЛЬНОМ сбое (MTProto-сервис недоступен): кейс
    // «нет статистики у мелкого канала» Python отдаёт как 200 {available:false}
    // и оно проходит насквозь. Поэтому здесь честный 503 для мониторинга.
    res.status(503).json({ error: e.message, available: false, hint: 'MTProto сервис недоступен' });
  }
}));

app.get('/api/tg/mtproto/graphs', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
  if (await serveSnapshot(req, res, d => d.graphs)) return;
  const cacheKey = `mtproto:graphs:${req.channel.id}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    if (!consumeSourceRefreshQuota(req, res)) return;
    const data = await mtprotoFetch('/graphs', {}, MTPROTO_TIMEOUT_HEAVY_MS);
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message, available: false });
  }
}));

// Velocity сервится из Postgres-снапшота (его строит ingest-крон), поэтому в
// пользовательском запросе НЕТ тяжёлых последовательных вызовов Telegram.
// Live-расчёт остаётся только fallback'ом: первый запуск до первого крона или
// режим без БД — тогда считаем на лету один раз и кэшируем.
app.get('/api/tg/mtproto/velocity', requireAuth, resolveChannel, async (req, res) => {
  const cacheKey = `mtproto:velocity:${req.channel.id}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    if (db.enabled && req.channel.id) {
      const snap = await db.getLatestVelocity(req.channel.id).catch(() => null);
      if (snap && snap.data) {
        const out = { ...snap.data, source: 'db', computed_at: snap.computed_at };
        cacheSet(cacheKey, out);
        return res.json(out);
      }
    }

    // нет снапшота (до первого крона) → live-расчёт ТОЛЬКО для central-канала
    // (у остальных данные приходят коллектором в Postgres).
    if (req.channel.source !== 'central') return res.json({ available: false, source: 'collector', empty: true });
    if (!consumeSourceRefreshQuota(req, res)) return;
    const data = await mtprotoFetch('/velocity', {}, MTPROTO_TIMEOUT_HEAVY_MS);
    if (data && data.available) {
      data.source = 'live';
      cacheSet(cacheKey, data);   // не кэшируем неуспех
    }
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message, available: false });
  }
});

// Brand mentions — cached longer (searchPosts has a ~10/day free quota) to avoid
// burning it on repeated loads. Cache TTL here is the 10-min default; the Python
// side also checks free quota before each search and never spends Stars.
app.get('/api/tg/mtproto/mentions', requireAuth, resolveChannel, async (req, res) => {
  if (notCentral(req, res)) return;   // live brand-search is central-only
  const cacheKey = `mtproto:mentions:${req.channel.id}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    if (!consumeSourceRefreshQuota(req, res)) return;
    const data = await mtprotoFetch('/mentions', {}, MTPROTO_TIMEOUT_HEAVY_MS);
    if (data && data.available) {
      // accumulate the full deduped list into the archive (history beyond searchPosts' window)
      if (Array.isArray(data.all) && req.channel.id) {
        db.upsertMentions(req.channel.id, data.all).catch(e => console.error('[db] mentions upsert:', e.message));
      }
      delete data.all;                 // don't ship the full list to the client
      cacheSet(cacheKey, data);         // don't cache failures
    }
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message, available: false });
  }
});

app.get('/api/tg/mtproto/post_stats/:id', requireAuth, resolveChannel, async (req, res) => {
  if (notCentral(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const cacheKey = `mtproto:poststats:${req.channel.id}:${id}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    if (!consumeSourceRefreshQuota(req, res)) return;
    const data = await mtprotoFetch('/post_stats/' + id, {}, MTPROTO_TIMEOUT_STATS_MS);
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(503).json({ available: false, error: e.message });
  }
});

// ── Public media proxies (thumb / channel photo) ─────────────────────────────
// Deliberately unauthenticated: they back plain <img src> tags, which can't send
// the x-session-token header. Tradeoff accepted because the central channel is
// public anyway (the proxy only reveals what t.me already shows); revisit with
// signed URLs if private channels ever land. Beyond the global /api limiter
// (per-IP for anonymous traffic), a dedicated modest per-IP limiter keeps an
// anonymous scraper from hammering the MTProto service through these routes.
const mediaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Слишком много запросов. Попробуй через минуту.' }
});

// Post thumbnail (binary) — open route so <img src> works without a header.
// Low sensitivity: only serves thumbnails of the configured (public) channel.
app.get('/api/tg/mtproto/thumb/:id', mediaLimiter, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).end();
  const size = req.query.size === 'lg' ? 'lg' : 'sm';
  try {
    const r = await fetchWithTimeout(`${MTPROTO_URL}/thumb/${id}?size=${size}`, { headers: { 'x-internal-token': MTPROTO_TOKEN } });
    if (!r.ok) return res.status(r.status).end();
    const buf = await r.buffer();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    res.status(502).end();
  }
});

// Channel avatar (binary) — open route so <img src> works without a header.
// Low sensitivity: only the configured (public, 'central') channel's profile photo.
app.get('/api/tg/mtproto/channel/photo', mediaLimiter, async (req, res) => {
  try {
    const r = await fetchWithTimeout(`${MTPROTO_URL}/channel/photo`, { headers: { 'x-internal-token': MTPROTO_TOKEN } });
    if (!r.ok) return res.status(r.status).end();
    const buf = await r.buffer();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    res.status(502).end();
  }
});

app.get('/api/tg/full', requireAuth, resolveChannel, asyncHandler(async (req, res, next) => {
  if (req.channel && req.channel.source !== 'central') {   // collector channel → from snapshot
    const snap = req.channel.id ? await db.getSnapshot(req.channel.id).catch(() => null) : null;
    const d = (snap && snap.data) || {};
    return res.json({ channel: d.channel || {}, views_summary: d.views_summary || null, posts: d.posts || [], mtproto_available: !!d.channel, source: 'collector' });
  }
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  try {
    if (!consumeSourceRefreshQuota(req, res)) return;
    const [botChannel, mtChannel, viewsSummary, posts] = await Promise.allSettled([
      (async () => {
        const [chat, count] = await Promise.all([
          tgFetch('getChat',            { chat_id: TG_CHANNEL }),
          tgFetch('getChatMemberCount', { chat_id: TG_CHANNEL }),
        ]);
        return { title: chat.title, username: chat.username, description: chat.description || '', memberCount: count };
      })(),
      mtprotoFetch('/channel'),
      mtprotoFetch('/views_summary', { limit }, MTPROTO_TIMEOUT_STATS_MS),
      mtprotoFetch('/posts', { limit }),
    ]);

    const bot  = botChannel.status  === 'fulfilled' ? botChannel.value  : null;
    const mtp  = mtChannel.status   === 'fulfilled' ? mtChannel.value   : null;
    const vs   = viewsSummary.status=== 'fulfilled' ? viewsSummary.value: null;
    const ps   = posts.status       === 'fulfilled' ? posts.value       : null;

    res.json({
      channel: {
        ...(bot || {}),
        ...(mtp || {}),
        memberCount: bot?.memberCount || mtp?.members || 0,
        source: mtp ? 'mtproto+bot_api' : 'bot_api',
      },
      views_summary:   vs,
      posts:           ps?.posts || [],
      mtproto_available: !!mtp,
      errors: {
        bot:    botChannel.status  === 'rejected' ? botChannel.reason?.message  : null,
        mtp:    mtChannel.status   === 'rejected' ? mtChannel.reason?.message   : null,
        views:  viewsSummary.status=== 'rejected' ? viewsSummary.reason?.message: null,
        posts:  posts.status       === 'rejected' ? posts.reason?.message       : null,
      }
    });
  } catch (e) {
    next(e);
  }
}));

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
  // Preferred source is the x-ingest-token header; the query param keeps the existing
  // GitHub Actions cron working but is deprecated (tokens in URLs land in proxy logs).
  const token = req.headers['x-ingest-token'] || req.query.token;
  if (!process.env.INGEST_TOKEN || typeof token !== 'string' || !token
      || !timingSafeEqualStr(token, process.env.INGEST_TOKEN)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  if (!req.headers['x-ingest-token']) {
    log('warn', 'ingest_token_in_query_deprecated', { request_id: req.requestId });
  }
  if (!db.enabled) return res.status(200).json({ ok: false, reason: 'DATABASE_URL не задан — БД выключена' });
  const channelId = await db.getOwnerChannelId();   // central channel = "collector #0"
  if (!channelId) return res.status(503).json({ ok: false, reason: 'central channel not ready' });
  try {
    const [graphs, posts] = await Promise.all([
      mtprotoFetch('/graphs', { points: 400 }, MTPROTO_TIMEOUT_HEAVY_MS).catch(() => null),   // full range for the archive (dashboard uses 45)
      mtprotoFetch('/posts', { limit: 100 }).catch(() => null),
    ]);

    const dailyRows = db.graphsToDailyRows(graphs);
    const nDaily = await db.upsertChannelDaily(channelId, dailyRows);

    let nPosts = 0;
    if (posts && Array.isArray(posts.posts)) {
      const prows = posts.posts.map(tgPostToRow);
      nPosts = await db.upsertPosts(channelId, prows);
    }

    // Velocity ("жизнь поста") — тяжёлый расчёт (до ~12 последовательных
    // GetMessageStats к Telegram). Делаем его ЗДЕСЬ, в кроне (последовательно
    // после graphs/posts, чтобы не нагружать единственную Telethon-сессию
    // параллельно), и кладём снапшот в Postgres. Дашборд читает готовое из БД.
    let velocityOk = false;
    const velocity = await mtprotoFetch('/velocity', {}, MTPROTO_TIMEOUT_HEAVY_MS).catch(() => null);
    if (velocity && velocity.available) {
      await db.saveVelocity(channelId, velocity).catch(e => console.error('[db] velocity save:', e.message));
      velocityOk = true;
    }

    res.json({ ok: true, channel_daily: nDaily, posts: nPosts, velocity: velocityOk });

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

// ════════════════════════════════════════════════════════════════
//  БАГ-ТРЕКЕР (Postgres)
// ════════════════════════════════════════════════════════════════
app.post('/api/bugs', requireAuth, requireSuper, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена — баги негде сохранять' });
  const text = ((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'Опиши баг' });
  try {
    const bug = await db.createBug({ text, severity: req.body.severity, context: req.body.context, kind: req.body.kind });
    res.json(bug);
  } catch (e) { next(e); }
});

app.get('/api/bugs', requireAuth, requireSuper, async (req, res) => {
  try {
    res.json({ enabled: db.enabled, statuses: db.BUG_STATUSES, kinds: db.BUG_KINDS, bugs: await db.listBugs(req.query.status) });
  } catch (e) { res.status(200).json({ enabled: db.enabled, bugs: [], error: e.message }); }
});

app.patch('/api/bugs/:id', requireAuth, requireSuper, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const bug = await db.updateBug(id, (req.body && req.body.status));
    if (!bug) return res.status(404).json({ error: 'not found' });
    res.json(bug);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/bugs/:id', requireAuth, requireSuper, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try { await db.deleteBug(id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ── Client render-crash telemetry (P0) ──
// The widget + app error boundaries POST a caught render crash here so it is diagnosable in the
// admin Bugs surface (kind='crash') by its trace id — not just a lost console line. Any AUTHENTICATED
// user reports THEIR OWN crashes (no superuser gate — the point is to catch real users' crashes), so
// it is tightly rate limited, every field is length-capped, the uid is HASHED (not stored raw), and
// the server stamps its own deployed commit. Reporting must never fail loudly: storage errors are
// swallowed and acked, so a crash report can't itself become a crash.
const crashLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  // requireAuth runs BEFORE this limiter, so req.user is always set (no raw-ip fallback needed).
  keyGenerator: (req) => `crash:u${req.user.uid}`,
  message: { error: 'Слишком много отчётов об ошибках.' },
});
const SERVER_COMMIT = String(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev').slice(0, 7);
const hashUid = (uid) => crypto.createHash('sha256').update(`${uid}:${AUTH_SECRET}`).digest('hex').slice(0, 12);
app.post('/api/client-errors', requireAuth, crashLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    const traceId = str(b.traceId, 40) || '';
    const name = str(b.name, 120) || 'Error';
    const message = str(b.message, 500) || '';
    const scope = b.scope === 'app' ? 'app' : 'widget';
    const route = str(b.route, 200) || '';
    const widgetId = str(b.widgetId, 120);
    const label = str(b.label, 160);
    // Trace id in the VISIBLE text (not just the context JSON) so an admin finds a crash by the id
    // the user quotes straight from the Bugs list — no need to expand each row's context.
    const text = `[crash:${scope}] ${name}: ${message} · ${traceId}`.slice(0, 300);
    const context = JSON.stringify({
      traceId, scope, route, widgetId, label,
      componentStack: str(b.componentStack, 6000),
      uidHash: hashUid(req.user.uid),
      commit: SERVER_COMMIT,
      ua: str(req.headers['user-agent'], 200),
      at: new Date().toISOString(),
    });
    if (db.enabled) {
      const row = await db.createCrash({ text, context });
      return res.json({ ok: true, id: row ? row.id : null, traceId });
    }
    console.error('[client-crash]', text, context); // no DB — Railway logs still capture it
    return res.json({ ok: false, traceId });
  } catch (e) {
    console.error('[client-crash] store failed', e && e.message);
    return res.json({ ok: false });
  }
});

// ── Hand a bug to Claude Code (manual gate) ──
// Fires a GitHub repository_dispatch → the claude-bugfix workflow attempts a fix and
// opens a PR (never pushes to main, which auto-deploys). Needs GITHUB_REPO +
// GITHUB_DISPATCH_TOKEN (PAT with repo/contents write) in the env; soft-off otherwise.
const GH_REPO  = process.env.GITHUB_REPO || '';            // e.g. "schulmannn/pulse-analytics"
const GH_TOKEN = process.env.GITHUB_DISPATCH_TOKEN || '';

app.post('/api/bugs/:id/claude-fix', requireAuth, requireSuper, async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  if (!GH_REPO || !GH_TOKEN) return res.status(503).json({ error: 'Не настроено: задай GITHUB_REPO и GITHUB_DISPATCH_TOKEN' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const bug = await db.getBug(id);
    if (!bug) return res.status(404).json({ error: 'баг не найден' });
    const r = await fetchWithTimeout(`https://api.github.com/repos/${GH_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'pulse-analytics-bugbot',
      },
      body: JSON.stringify({
        event_type: 'bug-fix-request',
        client_payload: {
          id: bug.id,
          text: String(bug.text || '').slice(0, 4000),
          severity: bug.severity,
          kind: bug.kind,
          context: bug.context || '',
          attachments: bug.attachment_count || 0,
        },
      }),
    });
    if (r.status !== 204) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: `GitHub dispatch failed (${r.status})`, detail: detail.slice(0, 300) });
    }
    await db.updateBug(id, 'in_progress').catch(() => {});   // reflect that Claude is on it
    res.json({ ok: true, status: 'in_progress' });
  } catch (e) { next(e); }
});

// ── Bug screenshots ──
// SECURITY INVARIANT: ALLOWED_IMG must stay raster-only. NEVER add image/svg+xml
// (or any scriptable type) — GET serves stored bytes with this mime, and SVG would
// enable stored XSS despite nosniff.
const ALLOWED_IMG = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMG_BYTES = 5 * 1024 * 1024;
const MAX_ATTACH_PER_BUG = 5;

// Verify the decoded bytes really are the claimed image type (magic bytes).
function sniffImage(mime, buf) {
  if (buf.length < 12) return false;
  if (mime === 'image/png')  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  if (mime === 'image/jpeg') return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  if (mime === 'image/gif')  return buf.slice(0, 4).toString('latin1') === 'GIF8';
  if (mime === 'image/webp') return buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  return false;
}

// route-local parser (after requireAuth) so only this authed route accepts big bodies
app.post('/api/bugs/:id/screenshot', requireAuth, requireSuper, express.json({ limit: '7mb' }), async (req, res, next) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  let { data, mime } = req.body || {};
  if (typeof data !== 'string' || !data) return res.status(400).json({ error: 'нет данных изображения' });
  const m = data.match(/^data:([^;,]+)[;,]/);          // data URL → trust its declared type (matches bytes)
  if (m) mime = m[1];
  data = data.replace(/^data:[^,]+,/, '');
  if (!mime) return res.status(400).json({ error: 'не удалось определить тип' });
  if (!ALLOWED_IMG.has(mime)) return res.status(415).json({ error: 'только изображения (png/jpeg/webp/gif)' });
  if (data.length > MAX_IMG_BYTES * 4 / 3 + 64) return res.status(413).json({ error: 'изображение больше 5 МБ' });
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'пустое или битое изображение' });
  if (buf.length > MAX_IMG_BYTES) return res.status(413).json({ error: 'изображение больше 5 МБ' });
  if (!sniffImage(mime, buf)) return res.status(415).json({ error: 'это не похоже на изображение' });
  try {
    if (!(await db.bugExists(id))) return res.status(404).json({ error: 'баг не найден' });
    const att = await db.addAttachmentIfRoom(id, mime, buf, MAX_ATTACH_PER_BUG);
    if (!att) return res.status(409).json({ error: `максимум ${MAX_ATTACH_PER_BUG} вложений на баг` });
    res.json(att);
  } catch (e) { next(e); }
});

// Served under auth (frontend fetches with the session token → blob URL).
app.get('/api/bug-attachment/:id', requireAuth, requireSuper, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).end();
  try {
    const a = await db.getAttachment(id);
    if (!a) return res.status(404).end();
    res.set('Content-Type', ALLOWED_IMG.has(a.mime) ? a.mime : 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(a.data);
  } catch (e) { next(e); }
});

// ── Sprint 3F-3 catover: new Vite/React SPA is the primary dashboard, served at '/' ──
// The dist/ bundle is produced by the Dockerfile.web build stage. CSP is stricter than
// the legacy shell: the new app has NO inline scripts (JSX auto-escapes), so script-src
// is plain 'self' — no nonce. The legacy nonce-shell stays at /legacy as a reversible
// escape hatch until the B2 cleanup (then this becomes the only HTML surface).
const APP_DIST = path.join(__dirname, '../frontend/dist');
const appCspHeader = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  // accounts.google.com is needed for "Sign in with Google" (GIS loads its client script, opens an
  // iframe for the button/One-Tap, and calls its endpoints). All trusted Google origins.
  "script-src 'self' https://accounts.google.com https://apis.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://accounts.google.com",
  "frame-src https://accounts.google.com",
].join('; ');
function setAppHeaders(req, res) {
  res.set('Content-Security-Policy', appCspHeader)
     .set('X-Content-Type-Options', 'nosniff')
     .set('Referrer-Policy', 'no-referrer');
  // HSTS only over TLS (Railway terminates it upstream; trust-proxy makes req.secure
  // honest). Never on plain-HTTP local dev — the browser would pin localhost to https.
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
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
  log('error', 'unhandled_error', {
    request_id: req.requestId,
    method: req.method,
    path: req.path,
    status,
    error: err && err.message,
    stack: err && err.stack,
  });
  const body = { error: status === 500 ? 'internal_error' : String((err && err.message) || 'error'), request_id: req.requestId };
  if (err && err.retryAfter) body.retry_after = err.retryAfter;
  res.status(status).json(body);
});

// ── Запуск ──────────────────────────────────────────────────────
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
