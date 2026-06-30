// ═══════════════════════════════════════════════════════════════
//  Pulse Analytics — Backend Server
//  Node.js + Express
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const db         = require('./db');
const { createAuth, hashPassword, verifyPassword, SCRYPT, rateLimitKey } = require('./lib/auth');
const { log, requestContext, hashIp } = require('./lib/observability');
const { makeResolveChannel, makeServeSnapshot } = require('./middleware/tenant');
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
// JSON body parser — default 100kb. Big-body routes (collector ingest, bug
// screenshots) carry their own higher-limit parser, so skip them here; otherwise
// this 100kb parser would reject their large payloads before the route is reached.
const jsonSmall = express.json();
app.use((req, res, next) => {
  if (req.path === '/api/collector/ingest' || /\/screenshot$/.test(req.path)) return next();
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

// ── Авторизация: stateless HMAC-токены (переживают рестарт/редеплой) ──
// Token signing secret. Prefer a dedicated SESSION_SECRET (separable from the
// team/MTProto password); fall back to TEAM_PASSWORD; never a hardcoded default —
// if neither is set, use an ephemeral random secret (tokens won't survive restart).
const AUTH_SECRET = process.env.SESSION_SECRET || process.env.TEAM_PASSWORD || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET && !process.env.TEAM_PASSWORD) {
  console.warn('[auth] no SESSION_SECRET/TEAM_PASSWORD set — using a random ephemeral secret; sessions will not survive restart');
}

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const SESSION_TTL = 8 * 60 * 60 * 1000;
const auth = createAuth({ secret: AUTH_SECRET });
const signToken = auth.signBreakGlass;
const signSession = auth.signSession;
const parseToken = auth.parseToken;

async function audit(req, action, metadata = {}) {
  if (!db.enabled) return false;
  return db.recordAuditEvent({
    uid: req.user && req.user.uid != null ? req.user.uid : null,
    channel_id: req.channel && req.channel.id != null ? req.channel.id : null,
    action,
    request_id: req.requestId,
    ip_hash: hashIp(req.ip, AUTH_SECRET),
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

// Auth: validates the token; for account sessions re-checks the user is still active
// (so role changes / disable take effect immediately, not only on next login).
async function requireAuth(req, res, next) {
  const sess = parseToken(req.headers['x-session-token']);
  if (!sess) return res.status(401).json({ error: 'Сессия истекла, войди снова' });
  req.session = sess;
  if (sess.uid == null) { req.user = { uid: null, role: 'superuser', email: null }; return next(); }
  try {
    const u = await db.getUserById(sess.uid);
    if (!u || u.status !== 'active') return res.status(401).json({ error: 'Аккаунт неактивен — войди снова' });
    if (sess.tokenVersion !== u.token_version) {
      return res.status(401).json({ error: 'Сессия отозвана — войди снова' });
    }
    req.user = { uid: u.id, role: u.role, email: u.email };
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
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

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry || entry.expires < Date.now()) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL });
}

// ── Email (verification / password reset) via Resend — no new dependency ──
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Pulse Analytics <onboarding@resend.dev>';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
// Hosts honoured from the request when APP_URL isn't set — defends emailed links
// against Host-header poisoning (reset link → account takeover). Best practice:
// set APP_URL in production. Override the allowlist with TRUSTED_HOSTS (comma-sep).
const TRUSTED_HOSTS = new Set(
  (process.env.TRUSTED_HOSTS || 'pulse-analytics-production-daf3.up.railway.app')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const VERIFY_TTL = 24 * 60 * 60 * 1000;
const RESET_TTL  = 60 * 60 * 1000;
const sha256   = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const escHtml  = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
// Public origin for emailed links. NEVER trust a raw Host header (poisonable):
// use APP_URL, else only an allow-listed / localhost host, else the canonical default.
function appBase(req) {
  if (APP_URL) return APP_URL;
  const host = String((req && req.get && req.get('host')) || '').toLowerCase();
  if (TRUSTED_HOSTS.has(host)) return 'https://' + host;                        // prod → https (never reflect X-Forwarded-Proto)
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return 'http://' + host;  // local dev
  return 'https://' + [...TRUSTED_HOSTS][0];                                    // untrusted host → canonical default
}
// Fixed-cost hash so login spends scrypt time even when the email doesn't exist
// (kills the "skip the hash on missing user" enumeration timing oracle).
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${'0'.repeat(32)}$${'0'.repeat(128)}`;

// Send via Resend (plain fetch). No key → log only non-secret metadata (never the
// rendered link/token). Never throws (auth flows stay generic on email failure).
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) { console.log(`[email:dev] to=${to} · "${subject}" (RESEND_API_KEY unset — not sent)`); return true; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
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
  `<p>Активируй аккаунт в Pulse Analytics:</p>${emailBtn(link, 'Подтвердить email')}<p style="color:#64748d;font-size:13px">Ссылка действует 24 часа. Если это были не вы — проигнорируйте письмо.</p>`);
const resetEmailHtml = (link) => emailShell('Сброс пароля',
  `<p>Задай новый пароль:</p>${emailBtn(link, 'Сбросить пароль')}<p style="color:#64748d;font-size:13px">Ссылка действует 1 час. Если это были не вы — проигнорируйте, пароль не изменится.</p>`);
const existsEmailHtml = (base) => emailShell('Аккаунт уже существует',
  `<p>На этот email уже есть аккаунт Pulse Analytics. Забыли пароль — <a href="${escHtml(base)}/?forgot=1">сбросьте его</a>.</p>`);

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
      if (eid) sendEmail(email, 'Аккаунт Pulse уже существует', existsEmailHtml(base)).catch(() => {});
      return;
    }
    const u = await db.createUser({ email, pass_hash: hashPassword(password), role: 'user', status: 'unverified' });
    const raw = newToken();
    const id = await db.createEmailToken(u.id, 'verify', sha256(raw), new Date(Date.now() + VERIFY_TTL));
    if (id) await sendEmail(email, 'Подтверди email — Pulse Analytics', verifyEmailHtml(`${base}/verify?token=${raw}`));
  } catch (e) {
    if (e.code !== '23505') console.error('[register]', e.message);   // already responded generically
  }
});

// Login: account (email+password) OR break-glass (team password, no email → superuser).
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  const password = String((req.body && req.body.password) || '');
  if (!password) return res.status(400).json({ error: 'Укажи пароль' });
  const expires = Date.now() + SESSION_TTL;

  if (email) {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
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
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // break-glass: shared team password → superuser session (no account)
  if (process.env.TEAM_PASSWORD && password === process.env.TEAM_PASSWORD) {
    return res.json({ token: signToken(expires), expiresAt: new Date(expires).toISOString(), user: { email: null, role: 'superuser' } });
  }
  return res.status(403).json({ error: 'Неверный пароль' });
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    if (req.user.uid != null) await db.revokeUserSessions(req.user.uid);
    audit(req, 'auth.logout', {}).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/check', requireAuth, (req, res) => {
  res.json({ ok: true, role: req.user.role, email: req.user.email });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ uid: req.user.uid, email: req.user.email, role: req.user.role });
});

// Email verification. GET serves an interstitial that does NOT consume the token —
// link-prefetchers (Outlook SafeLinks, AV scanners) issue GETs and a single-use
// token must survive that. The explicit button POSTs to consume + activate.
app.get('/api/auth/verify', (req, res) => {
  const tokenJs = JSON.stringify(String(req.query.token || '')).replace(/</g, '\\u003c');  // safe embed
  res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer')
    .send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подтверждение email</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;background:#e5edf5;color:#061b31;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.c{background:#fff;padding:32px;border-radius:8px;max-width:380px;text-align:center;box-shadow:0 4px 24px rgba(6,27,49,.08)}button{margin-top:18px;padding:11px 22px;background:#533afd;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer}.m{margin-top:14px;font-size:13px;color:#64748d}</style></head>
<body><div class="c"><h2>Подтверждение email</h2><p>Активируй аккаунт в Pulse Analytics.</p><button id="b">Подтвердить email</button><div class="m" id="m"></div></div>
<script>var t=${tokenJs};document.getElementById('b').onclick=function(){var b=this;b.disabled=true;b.textContent='…';fetch('/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})}).then(function(r){return r.json().catch(function(){return{}})}).then(function(j){if(j&&j.ok){location.href='/?verified=1';}else{document.getElementById('m').textContent=(j&&j.error)||'Ссылка недействительна или истекла';b.style.display='none';}}).catch(function(){document.getElementById('m').textContent='Ошибка сети';b.disabled=false;b.textContent='Подтвердить email';});};</script></body></html>`);
});

app.post('/api/auth/verify', authLimiter, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const raw = String((req.body && req.body.token) || '');
  if (!raw) return res.status(400).json({ error: 'Ссылка недействительна' });
  try {
    const t = await db.useEmailToken(sha256(raw), 'verify');
    if (!t) return res.status(400).json({ error: 'Ссылка недействительна или истекла' });
    const u = await db.getUserById(t.uid);
    if (u && u.status === 'unverified') { await db.setUserStatus(t.uid, 'active'); return res.json({ ok: true }); }
    if (u && u.status === 'active') return res.json({ ok: true });             // already verified — idempotent
    return res.status(400).json({ error: 'Аккаунт нельзя активировать' });     // disabled/pending: NOT via verify
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      if (id) await sendEmail(email, 'Сброс пароля — Pulse Analytics', resetEmailHtml(`${base}/reset?token=${raw}`));
    }
  } catch (e) { console.error('[forgot]', e.message); }   // already responded generically
});

// Password reset — consume token, set new password. Only promotes 'unverified'→'active'
// (a reset proves email ownership); never re-activates a disabled/pending account.
app.post('/api/auth/reset', authLimiter, async (req, res) => {
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
    res.json({ ok: true, message: 'Пароль обновлён — войди с новым паролем.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      if (id) await sendEmail(email, 'Подтверди email — Pulse Analytics', verifyEmailHtml(`${base}/verify?token=${raw}`));
    }
  } catch (e) { console.error('[resend]', e.message); }
});

// ── Персональная раскладка дашборда (порядок/скрытие/ширина блоков) ──
// Гость без аккаунта (break-glass uid=null) и режим без БД → null/no-op:
// клиент сам хранит раскладку в localStorage.
app.get('/api/prefs', requireAuth, async (req, res) => {
  if (req.user.uid == null) return res.json({ prefs: null });
  try { res.json({ prefs: await db.getPrefs(req.user.uid) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/prefs', requireAuth, async (req, res) => {
  const prefs = req.body && req.body.prefs;
  if (prefs == null || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return res.status(400).json({ error: 'prefs должен быть объектом' });
  }
  if (JSON.stringify(prefs).length > 8000) {
    return res.status(413).json({ error: 'prefs слишком большой' });
  }
  if (req.user.uid == null) return res.json({ ok: true, stored: false });
  try { await db.setPrefs(req.user.uid, prefs); res.json({ ok: true, stored: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  if (req.user.uid == null) return res.status(400).json({ error: 'Командный вход не имеет аккаунта для смены пароля' });
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const cur = String((req.body && req.body.current) || '');
  const next = String((req.body && req.body.next) || '');
  if (next.length < 8) return res.status(400).json({ error: 'Новый пароль минимум 8 символов' });
  try {
    const u = await db.getUserByEmail(req.user.email);
    if (!u || !verifyPassword(cur, u.pass_hash)) return res.status(403).json({ error: 'Текущий пароль неверен' });
    await db.setUserPassword(u.id, hashPassword(next));
    audit(req, 'auth.password_changed', {}).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: user management (superuser only) ──
app.get('/api/admin/users', requireAuth, requireSuper, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  try {
    res.json({ users: await db.listUsers(), roles: db.USER_ROLES, statuses: db.USER_STATUSES, me: req.user.uid });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const u = await db.updateUser(id, { role: req.body.role, status: req.body.status });
    if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(u);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  INSTAGRAM ROUTES
// ════════════════════════════════════════════════════════════════

// "Instagram API with Instagram Login" (no Facebook Page): the IG user access token works
// against graph.instagram.com, NOT graph.facebook.com. IG_ACCESS_TOKEN/IG_ACCOUNT_ID is the
// quick single-account path; per-channel OAuth tokens (ig_accounts) layer on top next.
const IG_BASE      = 'https://graph.instagram.com/v22.0';
const IG_TOKEN     = process.env.IG_ACCESS_TOKEN;
const IG_ACCOUNT   = process.env.IG_ACCOUNT_ID;
const igMock       = require('./ig_mock');
// No real credentials yet → serve deterministic mock payloads (same Graph API shape) so
// the IG analytics UI can be built/previewed ahead of a real account connection.
const igConfigured = () => !!IG_TOKEN && !!IG_ACCOUNT;

async function igFetch(path, params = {}) {
  params.access_token = IG_TOKEN;
  const qs  = new URLSearchParams(params).toString();
  const url = `${IG_BASE}${path}?${qs}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`Instagram API: ${json.error.message}`);
  return json;
}

// GET /api/ig/profile — профиль аккаунта (теперь с аватаркой)
app.get('/api/ig/profile', requireAuth, async (req, res) => {
  try {
    if (!igConfigured()) return res.json(igMock.igMockProfile());
    const cached = cacheGet('ig:profile');
    if (cached) return res.json(cached);

    const data = await igFetch(`/${IG_ACCOUNT}`, {
      fields: 'username,name,followers_count,follows_count,media_count,biography,website,profile_picture_url'
    });
    cacheSet('ig:profile', data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ig/insights?days=30 — метрики аккаунта
app.get('/api/ig/insights', requireAuth, async (req, res) => {
  const days = Math.min(90, parseInt(req.query.days, 10) || 30);
  const cacheKey = `ig:insights:${days}`;
  try {
    if (!igConfigured()) return res.json(igMock.igMockInsights(days));
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const SEC = 86400;
    const now = Math.floor(Date.now() / 1000);
    const curUntil = now, curSince = now - days * SEC;
    const prevUntil = curSince, prevSince = curSince - days * SEC;

    // Instagram API with Instagram Login (graph.instagram.com): only `reach` + `follower_count`
    // return a daily time-series. Fetch the full 90-day series so the panel can window the
    // selected period (cur vs prev) for these as before.
    const dailyCall = igFetch(`/${IG_ACCOUNT}/insights`, { metric: 'reach,follower_count', period: 'day', since: now - 90 * SEC, until: now });

    // Engagement/visibility metrics are window AGGREGATES (total_value) with no daily series, so
    // they can't be windowed client-side. Fetch each for the current and previous selected window
    // (per-metric allSettled → one unsupported metric, e.g. profile_views, can't blank the rest),
    // then re-shape each as two synthetic daily points (prev-window + current-window) placed inside
    // those windows, so the panel's existing windowPair() KPI/delta math reads them unchanged.
    const tvNames = ['views', 'profile_views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares'];
    const tvVal = (r) => { const m = r && r.data && r.data[0]; return m && m.total_value && m.total_value.value != null ? m.total_value.value : null; };
    const fetchTv = (s, u) => Promise.allSettled(
      tvNames.map((metric) => igFetch(`/${IG_ACCOUNT}/insights`, { metric, metric_type: 'total_value', period: 'day', since: s, until: u })),
    );
    const [dailyR, curR, prevR] = await Promise.all([
      dailyCall.catch(() => null),
      fetchTv(curSince, curUntil),
      fetchTv(prevSince, prevUntil),
    ]);
    const out = dailyR && dailyR.data ? [...dailyR.data] : [];
    const curPoint = new Date(curUntil * 1000).toISOString();
    const prevPoint = new Date((prevSince + Math.floor((days * SEC) / 2)) * 1000).toISOString();
    tvNames.forEach((metric, i) => {
      const cur = curR[i].status === 'fulfilled' ? tvVal(curR[i].value) : null;
      const prev = prevR[i].status === 'fulfilled' ? tvVal(prevR[i].value) : null;
      if (cur == null && prev == null) return;
      const values = [];
      if (prev != null) values.push({ value: prev, end_time: prevPoint });
      if (cur != null) values.push({ value: cur, end_time: curPoint });
      out.push({ name: metric, period: 'day', values, total_value: { value: cur } });
    });
    const data = { data: out };
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ig/posts?limit=20 — последние посты с инсайтами и превью
app.get('/api/ig/posts', requireAuth, async (req, res) => {
  const limit = Math.min(25, parseInt(req.query.limit, 10) || 20);
  const cacheKey = `ig:posts:${limit}`;
  try {
    if (!igConfigured()) return res.json(igMock.igMockPosts(limit));
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const mediaRes = await igFetch(`/${IG_ACCOUNT}/media`, {
      fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
      limit
    });

    const posts = await Promise.all(
      (mediaRes.data || []).map(async (post) => {
        // impressions deprecated 2025 → views. Reels carry watch-time (ms), only valid on REELS.
        const base = 'reach,views,shares,saved,total_interactions';
        const metric = post.media_product_type === 'REELS'
          ? `${base},ig_reels_avg_watch_time,ig_reels_video_view_total_time`
          : base;
        try {
          const ins = await igFetch(`/${post.id}/insights`, { metric, metric_type: 'total_value' });
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
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ig/breakdowns — audience demographics + format/contact breakdowns (modern
// total_value envelope, Graph v22+). Mock-backed when no creds.
app.get('/api/ig/breakdowns', requireAuth, async (req, res) => {
  const allowed = ['last_14_days', 'last_30_days', 'last_90_days'];
  const timeframe = allowed.includes(req.query.timeframe) ? req.query.timeframe : 'last_30_days';
  try {
    if (!igConfigured()) return res.json(igMock.igMockBreakdowns(timeframe));
    const cacheKey = `ig:breakdowns:${timeframe}`;
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
      calls.map((c) => igFetch(`/${IG_ACCOUNT}/insights`, c)),
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
app.get('/api/ig/online', requireAuth, async (req, res) => {
  try {
    if (!igConfigured()) return res.json(igMock.igMockOnlineFollowers());
    const cacheKey = 'ig:online';
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await igFetch(`/${IG_ACCOUNT}/insights`, { metric: 'online_followers', period: 'lifetime' });
    const result = { data: data?.data || [] };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(200).json({ data: [], error: e.message });
  }
});

// GET /api/ig/stories — active stories (last 24h) + per-story insights/navigation. Live
// window → not cached; tolerates per-story errors (#10 <5 viewers) and returns [] gracefully.
// Per-story metrics fetched INDEPENDENTLY (allSettled): on the Instagram-Login API a single
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

app.get('/api/ig/stories', requireAuth, async (req, res) => {
  // ── TEMP diagnostic (superuser + ?debug=1) — removed once the fix is verified on prod ──
  // Probes the raw upstream (read-only, token never echoed): which id/path returns stories, and
  // for a live story which insight metrics are valid + the navigation breakdown's dimension keys.
  if (req.query.debug === '1' && req.user && req.user.role === 'superuser') {
    if (!igConfigured()) return res.json({ debug: true, configured: false });
    const probe = async (path, params) => {
      try {
        const qs = new URLSearchParams({ ...params, access_token: IG_TOKEN }).toString();
        const r = await fetch(`${IG_BASE}${path}?${qs}`);
        const j = await r.json();
        return { path, status: r.status, data_len: Array.isArray(j.data) ? j.data.length : null, json: j };
      } catch (e) { return { path, error: e.message }; }
    };
    const me = await probe('/me', { fields: 'user_id,username,account_type,media_count' });
    const probes = [me];
    probes.push(await probe(`/${IG_ACCOUNT}/stories`, { fields: 'id,media_type,timestamp,permalink,thumbnail_url' }));
    const storyId = (() => {
      for (const p of probes) { const d = p.json && p.json.data; if (Array.isArray(d) && d[0] && d[0].id) return d[0].id; }
      return null;
    })();
    const insProbes = [];
    if (storyId) {
      // Combined call (the old request) — its error message names the offending metric.
      insProbes.push(await probe(`/${storyId}/insights`, { metric: 'reach,views,replies,shares,follows,profile_visits,total_interactions,navigation', metric_type: 'total_value', breakdown: 'story_navigation_action_type' }));
      // Per-metric validity (incl. legacy names) to learn the real supported set.
      for (const metric of ['reach', 'views', 'replies', 'shares', 'follows', 'profile_visits', 'total_interactions', 'navigation', 'impressions', 'exits', 'taps_forward', 'taps_back', 'profile_activity']) {
        insProbes.push(await probe(`/${storyId}/insights`, { metric, metric_type: 'total_value' }));
      }
      // Navigation breakdown keys.
      insProbes.push(await probe(`/${storyId}/insights`, { metric: 'navigation', metric_type: 'total_value', breakdown: 'story_navigation_action_type' }));
    }
    return res.json({ debug: true, ig_account: IG_ACCOUNT, ig_base: IG_BASE, story_id: storyId, probes, ins_probes: insProbes });
  }
  try {
    if (!igConfigured()) return res.json(igMock.igMockStories());
    const list = await igFetch(`/${IG_ACCOUNT}/stories`, {
      fields: 'id,media_type,timestamp,permalink,thumbnail_url',
    });
    const stories = await Promise.all(
      (list.data || []).map(async (s) => {
        const out = { ...s };
        // Each metric independently — one unsupported metric blanks only itself; the story and
        // its remaining metrics always survive (the story is never dropped).
        const settled = await Promise.allSettled(
          STORY_METRICS.map((metric) => igFetch(`/${s.id}/insights`, { metric, metric_type: 'total_value' })),
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
          });
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
    res.json({ data: stories }); // never filter — a story must survive insight failures
  } catch (e) {
    res.status(200).json({ data: [], error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  TELEGRAM — Bot API
// ════════════════════════════════════════════════════════════════

const TG_BASE    = 'https://api.telegram.org/bot';
const TG_TOKEN   = process.env.TG_BOT_TOKEN;
const TG_CHANNEL = process.env.TG_CHANNEL;

async function tgFetch(method, params = {}) {
  const url = new URL(`${TG_BASE}${TG_TOKEN}/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res  = await fetch(url.toString());
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram API: ${json.description}`);
  return json.result;
}

// Channels (tenants) the user owns — drives the dashboard channel switcher.
// No DB → one synthetic 'central' channel (id 0) so the legacy single-channel
// dashboard still works locally without Postgres.
app.get('/api/channels', requireAuth, async (req, res) => {
  if (!db.enabled) return res.json({ enabled: false, channels: [{ id: 0, username: '', title: '', source: 'central' }], selected: 0 });
  if (!dbReady) return res.status(503).json({ error: 'Сервис запускается' });
  try {
    const channels = await db.listChannels(req.user);
    res.json({ enabled: true, channels, selected: channels[0] ? channels[0].id : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a channel (self-serve). Real accounts only (not the break-glass operator).
app.post('/api/channels', requireAuth, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  if (req.user.uid == null) return res.status(403).json({ error: 'Командный вход не может создавать каналы' });
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/channels/:id', requireAuth, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id || req.user.uid == null) return res.status(400).json({ error: 'bad id' });
  try {
    const ok = await db.deleteChannel(id, req.user.uid);
    if (ok) audit(req, 'channel.deleted', { channel_id: id }).catch(() => {});
    res.json({ ok });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate an API key for a channel the user owns — the raw key is shown ONCE.
app.post('/api/channels/:id/key', requireAuth, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id || req.user.uid == null) return res.status(400).json({ error: 'bad id' });
  try {
    const ch = await db.getChannel(id, req.user);
    if (!ch) return res.status(403).json({ error: 'Нет доступа к каналу' });
    if (ch.source === 'central') return res.status(400).json({ error: 'central-канал не использует collector-ключи' });
      const raw = 'pa_' + crypto.randomBytes(24).toString('base64url');
      const rec = await db.createApiKey(id, sha256(raw), raw.slice(0, 11), String((req.body && req.body.label) || '').slice(0, 60) || null);
      req.channel = ch;
      audit(req, 'api_key.created', { key_id: rec.id, key_prefix: rec.key_prefix }).catch(() => {});
      res.json({ ...rec, key: raw });   // raw key — never stored, shown once
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/channels/:id/keys', requireAuth, async (req, res) => {
  if (!db.enabled) return res.json({ keys: [] });
  const id = parseInt(req.params.id, 10);
  if (!id || req.user.uid == null) return res.status(400).json({ error: 'bad id' });
  try { res.json({ keys: await db.listApiKeys(id, req.user.uid) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/channels/:id/key/:keyId', requireAuth, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const keyId = parseInt(req.params.keyId, 10);
  if (!keyId || req.user.uid == null) return res.status(400).json({ error: 'bad id' });
  try {
    const ok = await db.revokeApiKey(keyId, req.user.uid);
    if (ok) audit(req, 'api_key.revoked', { key_id: keyId }).catch(() => {});
    res.json({ ok });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

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

app.get('/api/tg/channel', requireAuth, resolveChannel, async (req, res) => {
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
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  TELEGRAM — MTProto прокси
// ════════════════════════════════════════════════════════════════

const MTPROTO_URL  = process.env.MTPROTO_URL || 'http://localhost:8001';
const MTPROTO_PASS = process.env.TEAM_PASSWORD || '';

async function mtprotoFetch(path, params = {}) {
  const url = new URL(MTPROTO_URL + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res  = await fetch(url.toString(), {
    headers: { 'x-internal-token': MTPROTO_PASS }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `MTProto error ${res.status}`);
  }
  return res.json();
}

app.get('/api/tg/mtproto/health', requireAuth, async (req, res) => {
  try {
    const data = await mtprotoFetch('/health');
    res.json({ available: true, ...data });
  } catch (e) {
    res.json({ available: false, error: e.message });
  }
});

app.get('/api/tg/mtproto/channel', requireAuth, resolveChannel, async (req, res) => {
  if (await serveSnapshot(req, res, d => d.channel)) return;
  const cacheKey = `mtproto:channel:${req.channel.id}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/channel');
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, hint: 'MTProto сервис недоступен' });
  }
});

app.get('/api/tg/mtproto/posts', requireAuth, resolveChannel, async (req, res) => {
  if (await serveSnapshot(req, res, d => ({ posts: d.posts || [], count: (d.posts || []).length }))) return;
  const limit     = Math.min(100, parseInt(req.query.limit)     || 30);
  const offsetId  = parseInt(req.query.offset_id) || 0;
  const cacheKey  = `mtproto:posts:${req.channel.id}:${limit}:${offsetId}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/posts', { limit, offset_id: offsetId });
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, hint: 'MTProto сервис недоступен' });
  }
});

app.get('/api/tg/mtproto/views_summary', requireAuth, resolveChannel, async (req, res) => {
  if (await serveSnapshot(req, res, d => d.views_summary)) return;
  const limit    = Math.min(100, parseInt(req.query.limit) || 30);
  const cacheKey = `mtproto:views:${req.channel.id}:${limit}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/views_summary', { limit });
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, hint: 'MTProto сервис недоступен' });
  }
});

app.get('/api/tg/mtproto/stats', requireAuth, resolveChannel, async (req, res) => {
  if (await serveSnapshot(req, res, d => d.stats)) return;
  const cacheKey = `mtproto:stats:${req.channel.id}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/stats');
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    // Сюда попадаем только при РЕАЛЬНОМ сбое (MTProto-сервис недоступен): кейс
    // «нет статистики у мелкого канала» Python отдаёт как 200 {available:false}
    // и оно проходит насквозь. Поэтому здесь честный 503 для мониторинга.
    res.status(503).json({ error: e.message, available: false, hint: 'MTProto сервис недоступен' });
  }
});

app.get('/api/tg/mtproto/graphs', requireAuth, resolveChannel, async (req, res) => {
  if (await serveSnapshot(req, res, d => d.graphs)) return;
  const cacheKey = `mtproto:graphs:${req.channel.id}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/graphs');
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message, available: false });
  }
});

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
    const data = await mtprotoFetch('/velocity');
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
    const data = await mtprotoFetch('/mentions');
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
    const data = await mtprotoFetch('/post_stats/' + id);
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(503).json({ available: false, error: e.message });
  }
});

// Post thumbnail (binary) — open route so <img src> works without a header.
// Low sensitivity: only serves thumbnails of the configured (public) channel.
app.get('/api/tg/mtproto/thumb/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).end();
  const size = req.query.size === 'lg' ? 'lg' : 'sm';
  try {
    const r = await fetch(`${MTPROTO_URL}/thumb/${id}?size=${size}`, { headers: { 'x-internal-token': MTPROTO_PASS } });
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
app.get('/api/tg/mtproto/channel/photo', async (req, res) => {
  try {
    const r = await fetch(`${MTPROTO_URL}/channel/photo`, { headers: { 'x-internal-token': MTPROTO_PASS } });
    if (!r.ok) return res.status(r.status).end();
    const buf = await r.buffer();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    res.status(502).end();
  }
});

app.get('/api/tg/full', requireAuth, resolveChannel, async (req, res) => {
  if (req.channel && req.channel.source !== 'central') {   // collector channel → from snapshot
    const snap = req.channel.id ? await db.getSnapshot(req.channel.id).catch(() => null) : null;
    const d = (snap && snap.data) || {};
    return res.json({ channel: d.channel || {}, views_summary: d.views_summary || null, posts: d.posts || [], mtproto_available: !!d.channel, source: 'collector' });
  }
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  try {
    const [botChannel, mtChannel, viewsSummary, posts] = await Promise.allSettled([
      (async () => {
        const [chat, count] = await Promise.all([
          tgFetch('getChat',            { chat_id: TG_CHANNEL }),
          tgFetch('getChatMemberCount', { chat_id: TG_CHANNEL }),
        ]);
        return { title: chat.title, username: chat.username, description: chat.description || '', memberCount: count };
      })(),
      mtprotoFetch('/channel'),
      mtprotoFetch('/views_summary', { limit }),
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
    res.status(500).json({ error: e.message });
  }
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
      auth: !!process.env.TEAM_PASSWORD
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
app.post('/api/ingest/daily', async (req, res) => {
  const token = req.query.token || req.headers['x-ingest-token'];
  if (!process.env.INGEST_TOKEN || token !== process.env.INGEST_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  if (!db.enabled) return res.status(200).json({ ok: false, reason: 'DATABASE_URL не задан — БД выключена' });
  const channelId = await db.getOwnerChannelId();   // central channel = "collector #0"
  if (!channelId) return res.status(503).json({ ok: false, reason: 'central channel not ready' });
  try {
    const [graphs, posts] = await Promise.all([
      mtprotoFetch('/graphs', { points: 400 }).catch(() => null),   // full range for the archive (dashboard uses 45)
      mtprotoFetch('/posts', { limit: 100 }).catch(() => null),
    ]);

    const dailyRows = db.graphsToDailyRows(graphs);
    const nDaily = await db.upsertChannelDaily(channelId, dailyRows);

    let nPosts = 0;
    if (posts && Array.isArray(posts.posts)) {
      const prows = posts.posts.map(p => {
        const reach = p.views || 0;
        const eng = (p.reactions || 0) + (p.forwards || 0) + (p.replies || 0);
        return {
          post_id: p.id, date_published: p.date,
          views: p.views || 0, reactions: p.reactions || 0, forwards: p.forwards || 0, replies: p.replies || 0,
          erv: reach > 0 ? eng / reach * 100 : null,
          virality: reach > 0 ? (p.forwards || 0) / reach * 100 : null,
          media_type: p.media_type, caption: (p.text || '').slice(0, 500), hashtags: p.hashtags || [],
        };
      });
      nPosts = await db.upsertPosts(channelId, prows);
    }

    // Velocity ("жизнь поста") — тяжёлый расчёт (до ~12 последовательных
    // GetMessageStats к Telegram). Делаем его ЗДЕСЬ, в кроне (последовательно
    // после graphs/posts, чтобы не нагружать единственную Telethon-сессию
    // параллельно), и кладём снапшот в Postgres. Дашборд читает готовое из БД.
    let velocityOk = false;
    const velocity = await mtprotoFetch('/velocity').catch(() => null);
    if (velocity && velocity.available) {
      await db.saveVelocity(channelId, velocity).catch(e => console.error('[db] velocity save:', e.message));
      velocityOk = true;
    }

    res.json({ ok: true, channel_daily: nDaily, posts: nPosts, velocity: velocityOk });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
app.post('/api/bugs', requireAuth, requireSuper, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена — баги негде сохранять' });
  const text = ((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'Опиши баг' });
  try {
    const bug = await db.createBug({ text, severity: req.body.severity, context: req.body.context, kind: req.body.kind });
    res.json(bug);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

app.delete('/api/bugs/:id', requireAuth, requireSuper, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try { await db.deleteBug(id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Hand a bug to Claude Code (manual gate) ──
// Fires a GitHub repository_dispatch → the claude-bugfix workflow attempts a fix and
// opens a PR (never pushes to main, which auto-deploys). Needs GITHUB_REPO +
// GITHUB_DISPATCH_TOKEN (PAT with repo/contents write) in the env; soft-off otherwise.
const GH_REPO  = process.env.GITHUB_REPO || '';            // e.g. "schulmannn/pulse-analytics"
const GH_TOKEN = process.env.GITHUB_DISPATCH_TOKEN || '';

app.post('/api/bugs/:id/claude-fix', requireAuth, requireSuper, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  if (!GH_REPO || !GH_TOKEN) return res.status(503).json({ error: 'Не настроено: задай GITHUB_REPO и GITHUB_DISPATCH_TOKEN' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const bug = await db.getBug(id);
    if (!bug) return res.status(404).json({ error: 'баг не найден' });
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/dispatches`, {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
app.post('/api/bugs/:id/screenshot', requireAuth, requireSuper, express.json({ limit: '7mb' }), async (req, res) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Served under auth (frontend fetches with the session token → blob URL).
app.get('/api/bug-attachment/:id', requireAuth, requireSuper, async (req, res) => {
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
  } catch (e) { res.status(500).end(); }
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
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
].join('; ');
function setAppHeaders(res) {
  res.set('Content-Security-Policy', appCspHeader)
     .set('X-Content-Type-Options', 'nosniff')
     .set('Referrer-Policy', 'no-referrer');
}
// Hashed SPA assets at root (/assets/*). Security headers set per response.
app.use((req, res, next) => { setAppHeaders(res); next(); },
  express.static(APP_DIST, { index: false }));

// Pre-catover bookmarks under /app → root equivalent (302; temporary during catover).
app.get(['/app', '/app/*'], (req, res) => {
  const target = req.originalUrl.replace(/^\/app(?=[/?]|$)/, '') || '/';
  res.redirect(302, target.startsWith('/') ? target : '/' + target);
});

// Legacy nonce-shell — reversible escape hatch, removed in 3F-3 B2 cleanup.
app.get('/legacy', sendApp);

// SPA fallback: every other (non-/api, non-asset) GET serves the new app shell.
app.get('*', (req, res) => {
  setAppHeaders(res);
  res.sendFile(path.join(APP_DIST, 'index.html'), (err) => { if (err) res.status(404).end(); });
});

// ── Запуск ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║        Pulse Analytics Server            ║
╠══════════════════════════════════════════╣
║  URL:      http://localhost:${PORT}          ║
║  IG API:   ${IG_TOKEN ? '✅ настроен' : '❌ не задан (IG_ACCESS_TOKEN)'}           ║
║  TG API:   ${TG_TOKEN ? '✅ настроен' : '❌ не задан (TG_BOT_TOKEN)'}             ║
║  Auth:     ${process.env.TEAM_PASSWORD ? '✅ пароль задан' : '❌ TEAM_PASSWORD не задан'}        ║
╚══════════════════════════════════════════╝
  `);
});
