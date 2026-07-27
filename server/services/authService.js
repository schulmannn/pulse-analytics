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
  // Sliding idle window plus an absolute cap. Password login/Google/password-change
  // starts a new absolute window; ordinary activity can only slide inside it.
  const SESSION_TTL = config.auth.sessionTtlMs || 7 * 24 * 60 * 60 * 1000;
  const SESSION_ABSOLUTE_TTL =
    config.auth.sessionAbsoluteTtlMs || 30 * 24 * 60 * 60 * 1000;
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

  // Secure — от req.secure: trust proxy уже настроен, за Railway это true, на
  // локальном http — нет. append не затирает другую cookie того же ответа.
  function setSessionCookie(req, res, token, maxAgeMs = SESSION_TTL) {
    res.append('Set-Cookie', serializeSessionCookie(token, { secure: req.secure, maxAgeMs }));
  }

  // Сброс cookie (logout): пустое значение + Max-Age=0 с теми же атрибутами.
  function clearSessionCookie(req, res) {
    res.append('Set-Cookie', serializeSessionCookie('', { secure: req.secure, maxAgeMs: 0 }));
  }

  // Auth: validates the token, then re-checks the user is still active (so role
  // changes / disable take effect immediately, not only on next login). Every valid
  // session carries a numeric uid (parseToken rejects anything else), so req.user
  // always maps to a real users row.
  // Обычный API принимает сессию только из HttpOnly-cookie. X-Session-Token
  // разрешён исключительно одноразовому migrateSessionCookie ниже.
  async function requireAuth(req, res, next) {
    const cookieToken = readCookie(req.headers.cookie, SESSION_COOKIE);
    // Cookie-транспорт отвергает КРОСС-САЙТОВЫЕ запросы целиком (включая GET: SameSite=Lax
    // пропускает cookie на top-level навигациях, а у нас есть квотные GET — searchPosts
    // ~10/день, живые МС-отчёты). Sec-Fetch-Site шлют все современные браузеры; без
    // заголовка (старый Safari, curl) мутации всё равно ловит Origin-гейт ниже.
    const crossSite = req.headers['sec-fetch-site'] === 'cross-site';
    const sess = crossSite ? null : parseToken(cookieToken);
    if (!sess) {
      if (cookieToken && !crossSite) clearSessionCookie(req, res);
      return res.status(401).json({ error: 'Сессия истекла, войди снова' });
    }
    // CSRF-гейт: cookie браузер шлёт сам, поэтому мутация требует явного
    // same-origin Origin (или Referer для клиентов без Origin).
    if (MUTATION_METHODS.has(req.method) && !isCsrfSafe({
      origin: req.headers.origin,
      referer: req.headers.referer,
      requestOrigin: `${req.protocol}://${req.get('host')}`,
    })) {
      return res.status(403).json({ error: 'csrf' });
    }
    req.session = sess;
    try {
      const u = await db.getUserById(sess.uid);
      if (!u || u.status !== 'active') {
        clearSessionCookie(req, res);
        return res.status(401).json({ error: 'Аккаунт неактивен — войди снова' });
      }
      if (sess.tokenVersion !== u.token_version) {
        clearSessionCookie(req, res);
        return res.status(401).json({ error: 'Сессия отозвана — войди снова' });
      }
      req.user = { uid: u.id, role: u.role, email: u.email };
      // Центральная кэш-политика аутентифицированных ответов (аудит P2): cookie-auth JSON одного
      // арендатора не должен смешиваться в shared-кэше (CDN/прокси без Vary: Cookie). Railway
      // сегодня API не кэширует — защищаемся от будущей инфраструктуры одним местом, а не
      // надеждой на неё. Роут может осознанно переопределить (например, публичный media-прокси
      // ставит собственный Cache-Control ПОСЛЕ этого middleware).
      res.set('Cache-Control', 'private, no-store');
      // Sliding idle window, capped by maxExp. Browser JavaScript never sees the
      // refreshed token: only Set-Cookie rotates it.
      const now = Date.now();
      if (isSessionStale(sess.exp, now, SESSION_TTL)) {
        const exp = Math.min(now + SESSION_TTL, sess.maxExp);
        const fresh = signSession({
          uid: u.id,
          role: u.role,
          exp,
          maxExp: sess.maxExp,
          tokenVersion: u.token_version,
        });
        setSessionCookie(req, res, fresh, exp - now);
        res.set('Cache-Control', 'no-store'); // a response carrying a token must never be shared-cached
      }
      next();
    } catch (e) { next(e); }
  }

  // One-release bridge for browsers that still carry the pre-cookie session in
  // localStorage. This is the sole X-Session-Token consumer. It requires explicit
  // same-origin proof, validates current account/token_version, mints a NEW
  // bounded cookie, and returns no token to JavaScript.
  async function migrateSessionCookie(req, res, next) {
    if (!isCsrfSafe({
      origin: req.headers.origin,
      referer: req.headers.referer,
      requestOrigin: `${req.protocol}://${req.get('host')}`,
    }) || req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ error: 'csrf' });
    }
    const sess = parseToken(req.headers['x-session-token']);
    if (!sess) return res.status(401).json({ error: 'Сессия истекла, войди снова' });
    try {
      const u = await db.getUserById(sess.uid);
      if (!u || u.status !== 'active' || sess.tokenVersion !== u.token_version) {
        return res.status(401).json({ error: 'Сессия истекла, войди снова' });
      }
      const now = Date.now();
      // Rollout-era tokens have no max: give them one fresh 7-day bounded
      // window. A max-aware token can never widen its existing deadline.
      const maxExp = sess.legacyAbsolute
        ? now + SESSION_TTL
        : Math.min(sess.maxExp, now + SESSION_ABSOLUTE_TTL);
      const exp = Math.min(now + SESSION_TTL, maxExp);
      if (exp <= now) return res.status(401).json({ error: 'Сессия истекла, войди снова' });
      const fresh = signSession({
        uid: u.id,
        role: u.role,
        exp,
        maxExp,
        tokenVersion: u.token_version,
      });
      setSessionCookie(req, res, fresh, exp - now);
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true });
    } catch (e) {
      return next(e);
    }
  }

  function requireSuper(req, res, next) {
    if (!req.user || req.user.role !== 'superuser') return res.status(403).json({ error: 'Доступ только для администратора' });
    next();
  }

  return {
    AUTH_SECRET, ADMIN_EMAIL, SESSION_TTL, SESSION_ABSOLUTE_TTL, GOOGLE_CLIENT_ID,
    signSession, parseToken,
    VERIFY_TTL, RESET_TTL, sha256, newToken, DUMMY_HASH,
    bootstrapAdmin, claimOwnerChannel,
    requireAuth, requireSuper, migrateSessionCookie,
    setSessionCookie, clearSessionCookie,
  };
}

module.exports = { createAuthService };
