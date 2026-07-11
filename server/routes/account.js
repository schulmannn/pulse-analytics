'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Account-scoped + admin routes, extracted verbatim from index.js:
 *   • GET  /api/config            — public SPA runtime config (no secrets)
 *   • GET  /api/auth/check        — session probe (role/email)
 *   • GET/PUT /api/prefs          — per-user dashboard layout + widget configs
 *   • GET/PATCH/DELETE /api/admin/users[/:id] — superuser user management
 *   • GET  /api/account/export    — GDPR self-export (F5)
 *   • DELETE /api/account         — GDPR self-erase (F4)
 *
 * accountLimiter is defined here (its only consumers are export + delete): a shield against a
 * stolen token bulk-exporting or brute-forcing the email confirmation, not against the user.
 * requireSuper, sendEmail/emailShell, audit and GOOGLE_CLIENT_ID are shared with the rest of the
 * app and injected. Every admin/account write stays behind requireAuth (+ requireSuper where it
 * was) and the same self-lockout / superuser guards as before.
 */
function registerAccountRoutes({ app, requireAuth, requireSuper, db, audit, sendEmail, emailShell, GOOGLE_CLIENT_ID }) {
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
      const ok = await db.deleteUserAccount(req.user.uid);
      if (!ok) return res.status(404).json({ error: 'Пользователь не найден' });
      // Прощальное письмо СТРОГО ПОСЛЕ успешного коммита стирания: раньше оно уходило до
      // транзакции, и её откат (FK-гонка свипа, недоступная БД) оставлял юзера с письмом
      // «безвозвратно удалены» при целых данных. Адрес берём из req.user.email — он живёт в
      // памяти запроса и после стирания строки. Уведомление о destructive-действии сохраняется:
      // если аккаунт стёр вор с украденным токеном — владелец узнаёт.
      await sendEmail(req.user.email, 'Аккаунт удалён — Atlavue', emailShell('Аккаунт удалён',
        '<p>Ваш аккаунт Atlavue и все связанные данные (каналы, архивы, отчёты, подключения) ' +
        'только что безвозвратно удалены по запросу из настроек.</p>' +
        '<p style="color:#64748d;font-size:13px">Если это были не вы — ответьте на это письмо немедленно: ' +
        'остаточные копии в резервных бэкапах существуют ещё до 30 дней.</p>')).catch(() => {});
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}

module.exports = { registerAccountRoutes };
