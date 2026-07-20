// ═══════════════════════════════════════════════════════════════
//  Atlavue — auth service (сессии, guard-middleware, бутстрап админа)
// ═══════════════════════════════════════════════════════════════
// Фабрика auth-домена (декомпозиция index.js, PR C): подписанты сессий, requireAuth/
// requireSuper, бутстрап админ-аккаунта и утилиты auth-флоу (одноразовые email-токены,
// анти-enumeration DUMMY_HASH). Без чтения окружения/Express-app/listen/таймеров — всё из
// deps; тела перенесены из index.js literal (поведение-preserving).

'use strict';

const crypto = require('crypto');
const {
  createAuth, hashPassword, SCRYPT, isSessionStale,
  SESSION_COOKIE, readCookie, serializeSessionCookie, isCsrfSafe,
} = require('../lib/auth');

// Мутации, которые за cookie-транспортом обязаны пройти same-origin CSRF-проверку.
// Безопасные методы (GET/HEAD/OPTIONS) не меняют состояние — их не гейтим.
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function createAuthService({ config, db }) {
  // Token signing secret: a dedicated SESSION_SECRET and nothing else. There is no
  // fallback — a shared login password must never double as the session-forgery key.
  // Production refuses to boot without the required secrets (validateConfig в main.js);
  // dev gets a random per-process secret with a warning.
  const AUTH_SECRET = config.auth.sessionSecret || crypto.randomBytes(32).toString('hex');
  if (!config.auth.sessionSecret) {
    console.warn('[auth] SESSION_SECRET not set (dev) — using an ephemeral random secret; sessions will not survive a restart');
  }

  const ADMIN_EMAIL = config.auth.adminEmail;
  // Idle window: an active user is kept signed in by a sliding re-issue (see requireAuth) so this is
  // the MAX time between requests before a re-login is required, not a hard cap on a live session.
  const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
  const auth = createAuth({ secret: AUTH_SECRET });
  const signSession = auth.signSession;
  const parseToken = auth.parseToken;
  // "Sign in with Google" (Google Identity Services). The client id is public — it's both the GSI
  // button's client_id AND the audience we verify the returned ID token against. No client secret is
  // needed for the ID-token flow. Unset → the feature is inert (frontend hides the button).
  const GOOGLE_CLIENT_ID = config.auth.googleClientId;

  const VERIFY_TTL = 24 * 60 * 60 * 1000;
  const RESET_TTL  = 60 * 60 * 1000;
  const sha256   = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const newToken = () => crypto.randomBytes(32).toString('base64url');
  // Fixed-cost hash so login spends scrypt time even when the email doesn't exist
  // (kills the "skip the hash on missing user" enumeration timing oracle).
  const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${'0'.repeat(32)}$${'0'.repeat(128)}`;

  // Optional bootstrap: create the ADMIN_EMAIL account as an active superuser at startup
  // (needs ADMIN_PASSWORD). Removes the register-time race for the admin email.
  async function bootstrapAdmin() {
    if (!db.enabled || !ADMIN_EMAIL || !config.auth.adminPassword) return;
    try {
      if (!(await db.getUserByEmail(ADMIN_EMAIL))) {
        await db.createUser({ email: ADMIN_EMAIL, pass_hash: await hashPassword(config.auth.adminPassword), role: 'superuser', status: 'active' });
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

  // Ставит/обновляет сессионную cookie тем же токеном, что уходит в JSON/заголовке
  // (cookie-auth фаза 1: меняется только транспорт, не формат токена). Secure — от
  // req.secure: trust proxy уже настроен, за Railway это true, на локальном http — нет.
  // append (не set), чтобы не затереть чужой Set-Cookie на том же ответе.
  function setSessionCookie(req, res, token) {
    res.append('Set-Cookie', serializeSessionCookie(token, { secure: req.secure, maxAgeMs: SESSION_TTL }));
  }

  // Сброс cookie (logout): пустое значение + Max-Age=0 с теми же атрибутами.
  function clearSessionCookie(req, res) {
    res.append('Set-Cookie', serializeSessionCookie('', { secure: req.secure, maxAgeMs: 0 }));
  }

  // Auth: validates the token, then re-checks the user is still active (so role
  // changes / disable take effect immediately, not only on next login). Every valid
  // session carries a numeric uid (parseToken rejects anything else), so req.user
  // always maps to a real users row.
  // Транспорт (фаза 1 cookie-auth): заголовок X-Session-Token ПРИОРИТЕТНЕЕ — cookie
  // 'pulse_session' читается только когда заголовка нет (битый header с валидной cookie
  // всё равно 401 — заголовок объявил намерение и проиграл). Токен один и тот же.
  async function requireAuth(req, res, next) {
    const headerToken = req.headers['x-session-token'];
    const viaCookie = !headerToken;
    // Cookie-транспорт отвергает КРОСС-САЙТОВЫЕ запросы целиком (включая GET: SameSite=Lax
    // пропускает cookie на top-level навигациях, а у нас есть квотные GET — searchPosts
    // ~10/день, живые МС-отчёты). Sec-Fetch-Site шлют все современные браузеры; без
    // заголовка (старый Safari, curl) поведение прежнее — мутации всё равно ловит
    // Origin-гейт ниже. Header-путь не гейтится: кастомный заголовок кросс-сайтово недоступен.
    const crossSite = viaCookie && req.headers['sec-fetch-site'] === 'cross-site';
    const sess = crossSite
      ? null
      : parseToken(viaCookie ? readCookie(req.headers.cookie, SESSION_COOKIE) : headerToken);
    if (!sess) return res.status(401).json({ error: 'Сессия истекла, войди снова' });
    // CSRF-гейт: мутацию, аутентифицированную через cookie (браузер шлёт её сам, в т.ч.
    // с чужого сайта), пускаем только при доказанном same-origin — Origin (или, без него,
    // Referer) равен origin запроса. Header-аутентифицированные запросы не трогаем:
    // кастомный заголовок недоступен кросс-сайтовой форме и сам по себе CSRF-барьер.
    if (viaCookie && MUTATION_METHODS.has(req.method) && !isCsrfSafe({
      origin: req.headers.origin,
      referer: req.headers.referer,
      requestOrigin: `${req.protocol}://${req.get('host')}`,
    })) {
      return res.status(403).json({ error: 'csrf' });
    }
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
        setSessionCookie(req, res, fresh); // cookie-транспорт скользит вместе с header-путём
        res.set('Cache-Control', 'no-store'); // a response carrying a token must never be shared-cached
      }
      next();
    } catch (e) { next(e); }
  }

  function requireSuper(req, res, next) {
    if (!req.user || req.user.role !== 'superuser') return res.status(403).json({ error: 'Доступ только для администратора' });
    next();
  }

  return {
    AUTH_SECRET, ADMIN_EMAIL, SESSION_TTL, GOOGLE_CLIENT_ID,
    signSession, parseToken,
    VERIFY_TTL, RESET_TTL, sha256, newToken, DUMMY_HASH,
    bootstrapAdmin, claimOwnerChannel,
    requireAuth, requireSuper,
    setSessionCookie, clearSessionCookie,
  };
}

module.exports = { createAuthService };
