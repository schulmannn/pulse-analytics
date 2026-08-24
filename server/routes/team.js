'use strict';

/* ── Команда: приглашения в воркспейс и участники ────────────────────────────────────────────────
   Раздел «Команда» в /settings до этого был витриной без бэкенда (ростер в localStorage, письма не
   уходили, доступ не выдавался). Здесь — недостающее звено: выпуск приглашения со ссылкой в письме,
   приём по ссылке и управление уже принятыми участниками.

   Место действия — ЛИЧНЫЙ воркспейс приглашающего (миграция 015 гарантирует ровно один на
   владельца). Принявший приглашение попадает в workspace_members, и с этого момента его видят все
   tenant-предикаты доступа (db/access.js) — то есть он получает ровно те источники, что лежат в
   этом воркспейсе, с ролью из приглашения (ранги в middleware/tenant.js).

   Публичные роуты (превью и приём по токену) сидят на authLimiter, как остальные токен-флоу: они
   бьют по БД без сессии. Токен в URL — сырой, в БД лежит только sha256 (как email_tokens). */

function registerTeamRoutes({
  app, db, requireAuth, authLimiter, audit, log,
  appBase, sha256, newToken, INVITE_TTL,
  sendEmail, emailConfigured, emailShell, emailBtn, escHtml,
  hashPassword, signSession, SESSION_TTL, SESSION_ABSOLUTE_TTL, setSessionCookie,
}) {
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const normalizeEmail = (value) => String(value || '').toLowerCase().trim();
  const dbOff = (res) => res.status(503).json({ error: 'БД не подключена' });

  const inviteEmailHtml = (link, workspace, inviter, roleLabel) => emailShell(
    'Приглашение в Atlavue',
    `<p>${escHtml(inviter)} приглашает вас в рабочее пространство <b>${escHtml(workspace)}</b> — роль «${escHtml(roleLabel)}».</p>`
    + emailBtn(link, 'Принять приглашение')
    + '<p style="color:#64748d;font-size:13px">Ссылка действует 7 дней и открывает доступ только к данным этого пространства. '
    + 'Если вы не ждали приглашения — просто проигнорируйте письмо.</p>');

  const ROLE_LABEL = { admin: 'Администратор', member: 'Редактор', viewer: 'Наблюдатель' };

  /* Общий сбор состояния «Команды». Один и тот же кадр отдают и GET, и мутации — фронт после
     любой правки получает согласованный ростер вместо отдельного рефетча. `seats.limit` —
     СЕРВЕРНЫЙ кап (тарифные лимиты фронта живут в lib/plan.ts и на доступ не влияют). */
  async function teamState(uid) {
    const workspace = await db.ensureTeamWorkspace(uid);
    if (!workspace) return null;
    const [members, invites, memberships, used] = await Promise.all([
      db.listWorkspaceMembers(workspace.id),
      db.listWorkspaceInvites(workspace.id),
      db.listForeignMemberships(uid),
      db.countWorkspaceSeats(workspace.id),
    ]);
    return {
      workspace: { id: workspace.id, name: workspace.name },
      members,
      invites,
      memberships,
      seats: { used, limit: db.MAX_WORKSPACE_SEATS },
      // Честность поверхности: без RESEND_API_KEY сервер только пишет письмо в лог. UI обязан
      // сказать это вслух, а не рисовать «приглашение отправлено».
      email_configured: emailConfigured(),
    };
  }

  // ── Ростер ────────────────────────────────────────────────────────
  app.get('/api/team', requireAuth, async (req, res, next) => {
    if (!db.enabled) return dbOff(res);
    try {
      const state = await teamState(req.user.uid);
      if (!state) return res.status(503).json({ error: 'Рабочее пространство недоступно' });
      res.json(state);
    } catch (e) { next(e); }
  });

  // ── Выпуск приглашения ───────────────────────────────────────────
  app.post('/api/team/invites', requireAuth, authLimiter, async (req, res, next) => {
    if (!db.enabled) return dbOff(res);
    const email = normalizeEmail(req.body && req.body.email);
    const role = String((req.body && req.body.role) || 'member');
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Некорректный email' });
    if (!db.INVITE_ROLES.includes(role)) return res.status(400).json({ error: 'Неизвестная роль' });
    if (email === normalizeEmail(req.user.email)) {
      return res.status(400).json({ error: 'Это ваш собственный email' });
    }
    try {
      const workspace = await db.ensureTeamWorkspace(req.user.uid);
      if (!workspace) return res.status(503).json({ error: 'Рабочее пространство недоступно' });
      const raw = newToken();
      const result = await db.createWorkspaceInvite({
        workspaceId: workspace.id,
        email,
        role,
        tokenHash: sha256(raw),
        invitedBy: req.user.uid,
        expiresAt: new Date(Date.now() + INVITE_TTL),
      });
      if (result.outcome === 'already_member') {
        return res.status(409).json({ error: 'Этот человек уже в команде' });
      }
      if (result.outcome === 'cooldown') {
        return res.status(429).json({ error: 'Письмо этому адресу уже ушло — повторить можно через минуту' });
      }
      if (result.outcome === 'full') {
        return res.status(409).json({ error: `Все места заняты (максимум ${result.limit})` });
      }
      // Ссылка собирается ДО отправки из доверенного origin (appBase защищён от Host-header
      // poisoning) — тот же приём, что у verify/reset.
      const link = `${appBase(req)}/invite?token=${raw}`;
      const delivered = await sendEmail(
        email,
        `Приглашение в Atlavue — ${workspace.name}`,
        inviteEmailHtml(link, workspace.name, req.user.email, ROLE_LABEL[role] || role),
        link,
      );
      audit(req, 'team.invited', { workspace_id: workspace.id, role, reissued: !!result.reissued }).catch(() => {});
      if (!delivered) {
        log('warn', 'team_invite_email_failed', { workspace_id: workspace.id, invite_id: result.invite.id });
      }
      const state = await teamState(req.user.uid);
      res.json({ ok: true, delivered: !!delivered, invite: result.invite, ...state });
    } catch (e) { next(e); }
  });

  // ── Отзыв приглашения ────────────────────────────────────────────
  app.delete('/api/team/invites/:id', requireAuth, async (req, res, next) => {
    if (!db.enabled) return dbOff(res);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const workspace = await db.ensureTeamWorkspace(req.user.uid);
      if (!workspace) return res.status(503).json({ error: 'Рабочее пространство недоступно' });
      const ok = await db.revokeWorkspaceInvite(workspace.id, id);
      if (!ok) return res.status(404).json({ error: 'Приглашение не найдено' });
      audit(req, 'team.invite_revoked', { workspace_id: workspace.id, invite_id: id }).catch(() => {});
      res.json({ ok: true, ...(await teamState(req.user.uid)) });
    } catch (e) { next(e); }
  });

  // ── Роль участника ───────────────────────────────────────────────
  app.patch('/api/team/members/:uid', requireAuth, async (req, res, next) => {
    if (!db.enabled) return dbOff(res);
    const uid = parseInt(req.params.uid, 10);
    const role = String((req.body && req.body.role) || '');
    if (!uid) return res.status(400).json({ error: 'bad uid' });
    if (!db.INVITE_ROLES.includes(role)) return res.status(400).json({ error: 'Неизвестная роль' });
    if (uid === req.user.uid) return res.status(400).json({ error: 'Нельзя менять собственную роль' });
    try {
      const workspace = await db.ensureTeamWorkspace(req.user.uid);
      if (!workspace) return res.status(503).json({ error: 'Рабочее пространство недоступно' });
      const ok = await db.setWorkspaceMemberRole(workspace.id, uid, role);
      if (!ok) return res.status(404).json({ error: 'Участник не найден' });
      audit(req, 'team.member_role_changed', { workspace_id: workspace.id, target_uid: uid, role }).catch(() => {});
      res.json({ ok: true, ...(await teamState(req.user.uid)) });
    } catch (e) { next(e); }
  });

  // ── Исключение участника ─────────────────────────────────────────
  // Доступ пропадает мгновенно: предикаты в db/access.js читают workspace_members на КАЖДОМ
  // запросе, отдельной ревокации сессии не нужно.
  app.delete('/api/team/members/:uid', requireAuth, async (req, res, next) => {
    if (!db.enabled) return dbOff(res);
    const uid = parseInt(req.params.uid, 10);
    if (!uid) return res.status(400).json({ error: 'bad uid' });
    if (uid === req.user.uid) return res.status(400).json({ error: 'Нельзя исключить самого себя' });
    try {
      const workspace = await db.ensureTeamWorkspace(req.user.uid);
      if (!workspace) return res.status(503).json({ error: 'Рабочее пространство недоступно' });
      const ok = await db.removeWorkspaceMember(workspace.id, uid);
      if (!ok) return res.status(404).json({ error: 'Участник не найден' });
      audit(req, 'team.member_removed', { workspace_id: workspace.id, target_uid: uid }).catch(() => {});
      res.json({ ok: true, ...(await teamState(req.user.uid)) });
    } catch (e) { next(e); }
  });

  // ── Публичное превью приглашения ─────────────────────────────────
  // Отдаёт только то, что получатель письма и так видит у себя в ящике. Мёртвая ссылка честно
  // называет причину, иначе страница предлагала бы завести аккаунт впустую.
  app.get('/api/team/invite/:token', authLimiter, async (req, res, next) => {
    if (!db.enabled) return dbOff(res);
    try {
      const invite = await db.getWorkspaceInviteByToken(sha256(String(req.params.token || '')));
      if (!invite) return res.status(404).json({ error: 'Приглашение не найдено' });
      res.json({
        status: invite.status,
        email: invite.email,
        role: invite.role,
        workspace: invite.workspace_name,
        invited_by: invite.invited_by_email,
        // Заводить пароль на этой странице можно, только когда аккаунта ещё нет (или он так и не
        // подтверждён) — иначе ссылка стала бы обходным сбросом пароля живого аккаунта.
        needs_account: invite.invitee_status == null || invite.invitee_status === 'unverified',
      });
    } catch (e) { next(e); }
  });

  const acceptError = (res, outcome) => {
    const message = {
      invalid: 'Приглашение не найдено',
      revoked: 'Приглашение отозвано',
      already_accepted: 'Приглашение уже принято',
      expired: 'Срок действия ссылки истёк — попросите выслать новую',
      email_mismatch: 'Приглашение выписано на другой email',
    }[outcome] || 'Не удалось принять приглашение';
    return res.status(400).json({ error: message, code: outcome });
  };

  // ── Приём приглашения ДЕЙСТВУЮЩИМ аккаунтом ──────────────────────
  app.post('/api/team/invite/:token/accept', requireAuth, authLimiter, async (req, res, next) => {
    if (!db.enabled) return dbOff(res);
    try {
      const result = await db.acceptWorkspaceInvite({
        tokenHash: sha256(String(req.params.token || '')),
        uid: req.user.uid,
        email: req.user.email,
      });
      if (result.outcome !== 'accepted') return acceptError(res, result.outcome);
      audit(req, 'team.invite_accepted', { workspace_id: result.workspace_id, role: result.role }).catch(() => {});
      res.json({ ok: true, workspace: result.workspace_name, role: result.role });
    } catch (e) { next(e); }
  });

  /* ── Приём приглашения БЕЗ аккаунта (создать и сразу войти) ───────────────────────────────────
     Доставка письма доказывает владение ящиком — ровно то же основание, по которому verified-email
     от Google активирует аккаунт без нашего письма-подтверждения (routes/auth.js). Поэтому здесь
     создаётся сразу 'active' аккаунт, без второго круга «зарегистрируйтесь → подтвердите почту».

     Граница: путь работает ТОЛЬКО когда аккаунта нет либо он 'unverified'. Живой 'active' аккаунт
     не трогаем (иначе ссылка была бы обходным сбросом пароля) — просим войти и открыть ссылку
     снова. Для 'unverified' пароль ПЕРЕЗАПИСЫВАЕТСЯ выбранным сейчас: строка могла быть заранее
     засеяна атакующим с известным ему паролем, и без перезаписи приглашение подарило бы ему
     активный аккаунт на чужой ящик (тот же разбор, что в google-ветке auth.js). */
  app.post('/api/team/invite/:token/claim', authLimiter, async (req, res, next) => {
    if (!db.enabled) return dbOff(res);
    const password = String((req.body && req.body.password) || '');
    if (password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });
    const tokenHash = sha256(String(req.params.token || ''));
    try {
      const invite = await db.getWorkspaceInviteByToken(tokenHash);
      if (!invite) return acceptError(res, 'invalid');
      if (invite.status !== 'live') return acceptError(res, invite.status);

      const existing = await db.getUserByEmail(invite.email);
      if (existing && existing.status === 'active') {
        return res.status(409).json({ error: 'Аккаунт с этим email уже есть — войдите и откройте ссылку снова', code: 'login_required' });
      }
      if (existing && existing.status !== 'unverified') {
        return res.status(403).json({ error: 'Аккаунт неактивен — обратитесь к администратору' });
      }

      const passHash = await hashPassword(password);
      let user;
      if (existing) {
        await db.setUserPassword(existing.id, passHash);
        await db.setUserStatus(existing.id, 'active');
        user = await db.getUserById(existing.id);
      } else {
        try {
          user = await db.createUser({ email: invite.email, pass_hash: passHash, role: 'user', status: 'active' });
        } catch (e) {
          // Гонка с параллельной регистрацией на тот же email — аккаунт появился между чтением и
          // вставкой. Ответ тот же, что для живого аккаунта: войти и открыть ссылку снова.
          if (e.code === '23505') {
            return res.status(409).json({ error: 'Аккаунт с этим email уже есть — войдите и откройте ссылку снова', code: 'login_required' });
          }
          throw e;
        }
      }
      if (!user) return res.status(500).json({ error: 'Не удалось создать аккаунт' });

      const result = await db.acceptWorkspaceInvite({ tokenHash, uid: user.id, email: user.email });
      if (result.outcome !== 'accepted') return acceptError(res, result.outcome);

      const now = Date.now();
      const token = signSession({
        uid: user.id,
        role: user.role,
        exp: now + SESSION_TTL,
        maxExp: now + SESSION_ABSOLUTE_TTL,
        tokenVersion: user.token_version,
      });
      req.user = { uid: user.id, role: user.role, email: user.email };
      audit(req, 'team.invite_claimed', { workspace_id: result.workspace_id, role: result.role }).catch(() => {});
      setSessionCookie(req, res, token);
      res.json({ ok: true, workspace: result.workspace_name, role: result.role, user: { email: user.email, role: user.role } });
    } catch (e) { next(e); }
  });
}

module.exports = { registerTeamRoutes };
