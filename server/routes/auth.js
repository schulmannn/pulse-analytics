'use strict';

const crypto = require('crypto');

function registerAuthRoutes({
  app, express, db, requireAuth, authLimiter, asyncHandler,
  hashPassword, verifyPassword, DUMMY_HASH, signSession, SESSION_TTL,
  GOOGLE_CLIENT_ID, fetchWithTimeout, log, audit, appBase, sha256, newToken,
  VERIFY_TTL, RESET_TTL, sendEmail, emailShell, emailBtn, escHtml,
}) {
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
}

module.exports = { registerAuthRoutes };
