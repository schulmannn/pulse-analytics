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
  sendEmailDetailed, emailConfigured, escHtml,
  hashPassword, signSession, SESSION_TTL, SESSION_ABSOLUTE_TTL, setSessionCookie,
}) {
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const normalizeEmail = (value) => String(value || '').toLowerCase().trim();
  const dbOff = (res) => res.status(503).json({ error: 'БД не подключена' });

  const ROLE_LABEL = { admin: 'Администратор', member: 'Редактор', viewer: 'Наблюдатель' };
  const ROLE_CAN = {
    admin: 'управлять источниками и ключами',
    member: 'смотреть данные и вести заметки',
    viewer: 'только просмотр',
  };

  /* Приглашение — единственное письмо со СВОЕЙ вёрсткой (остальные живут на emailShell/emailBtn):
     это первое, что видит человек об Atlavue, поэтому у него есть марка, маскот и роль строкой
     данных. Таблицы + инлайн-стили — то, что переживает Gmail/Outlook/Яндекс/Mail.ru.

     ЖЁСТКИЕ ТРЕБОВАНИЯ ПОЧТОВЫХ САНИТАЙЗЕРОВ (проверено на Яндекс.Почте):
     • Полный ДОКУМЕНТ, а не фрагмент. Голый <table> без <html>/<head>/charset строгий санитайзер
       перебирает по-своему и глушит в нём интерактив — ссылка приходит целой, но не кликается.
     • Кнопка — «пуленепробиваемая»: фон на <td bgcolor>, ссылка внутри с padding. Ссылка со
       style="display:block" зависит от того, переживёт ли `display` чистку CSS; у <td bgcolor>
       такой зависимости нет, и кликабельна вся площадь.
     • SVG почта вырезает → маскот PNG с нашего же origin, с осмысленным alt: при выключенных
       картинках (дефолт для незнакомого отправителя) вместо пустоты видно слово.
     • Ячейка маскота несёт ЯВНЫЙ bgcolor: тёмная тема почты инвертирует фон, но не картинку,
       и чёрный силуэт на прозрачном фоне иначе исчезает. */
  const inviteEmailHtml = (link, workspace, inviter, role, base) => {
    const mono = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#8a8880;letter-spacing:0.08em;text-transform:uppercase';
    const sans = "font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif";
    return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>Приглашение в Atlavue</title>
</head>
<body style="margin:0;padding:0;background:#f3f2ee">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f2ee"><tr><td align="center" style="padding:28px 16px 36px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e4e2db;border-radius:12px">
  <tr><td style="padding:26px 30px 0">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="${sans};font-size:15px;font-weight:600;color:#1a1a17;letter-spacing:-0.01em">Atlavue</td>
      <td align="right" style="${mono}">Приглашение</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:20px 30px 0"><div style="height:1px;background:#e4e2db;line-height:1px">&nbsp;</div></td></tr>
  <tr><td style="padding:26px 30px 0">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td width="76" valign="top" bgcolor="#ffffff" style="padding-right:18px;background:#ffffff">
        <img src="${escHtml(base)}/email/detective.png" width="76" height="89" alt="Atlavue"
             style="display:block;width:76px;height:89px;border:0;outline:none;text-decoration:none">
      </td>
      <td valign="top" style="${sans}">
        <div style="font-size:23px;font-weight:600;color:#1a1a17;letter-spacing:-0.02em;line-height:1.25">Вас зовут в «${escHtml(workspace)}»</div>
        <div style="font-size:15px;color:#5c5b53;line-height:1.55;margin-top:10px"><b style="color:#1a1a17;font-weight:500">${escHtml(inviter)}</b> открывает вам доступ к аналитике своего пространства.</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px">
          <tr><td style="${mono};padding:0 14px 4px 0">Роль</td><td style="${mono};padding:0 0 4px">Что можно</td></tr>
          <tr>
            <td style="${sans};font-size:14px;color:#1a1a17;font-weight:500;padding-right:14px">${escHtml(ROLE_LABEL[role] || role)}</td>
            <td style="${sans};font-size:14px;color:#5c5b53">${escHtml(ROLE_CAN[role] || '')}</td>
          </tr>
        </table>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px 30px 28px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td align="center" bgcolor="#2d6be0" style="background:#2d6be0;border-radius:8px">
        <a href="${escHtml(link)}" target="_blank" rel="noopener" style="display:inline-block;width:100%;padding:13px 0;color:#ffffff;text-decoration:none;${sans};font-size:15px;font-weight:500">Принять приглашение</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
  };

  /* Текстовая альтернатива. Нужна не для красоты: письмо без text/plain хуже проходит фильтры, а
     в клиенте, который глушит ссылки в HTML (Яндекс так делает с незнакомыми отправителями),
     это единственное место, откуда адрес можно скопировать руками. */
  const inviteEmailText = (link, workspace, inviter, role) => [
    `${inviter} приглашает вас в рабочее пространство «${workspace}» в Atlavue.`,
    `Роль: ${ROLE_LABEL[role] || role} — ${ROLE_CAN[role] || ''}`.trim(),
    '',
    'Принять приглашение:',
    link,
  ].join('\n');

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
      workspace: { id: workspace.id, name: workspace.name, name_max: db.WORKSPACE_NAME_MAX },
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

  /* ── Название команды ────────────────────────────────────────────────────────────────────────
     По умолчанию имя воркспейса — локальная часть email владельца (миграция 010), поэтому
     приглашение звало «в schulmannn». Переименование скоупится тем же ensureTeamWorkspace, что и
     остальные мутации: пользователь правит ТОЛЬКО воркспейс, которым владеет. */
  app.patch('/api/team', requireAuth, async (req, res, next) => {
    if (!db.enabled) return dbOff(res);
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Название не может быть пустым' });
    if (name.length > db.WORKSPACE_NAME_MAX) {
      return res.status(400).json({ error: `Не длиннее ${db.WORKSPACE_NAME_MAX} символов` });
    }
    try {
      const workspace = await db.ensureTeamWorkspace(req.user.uid);
      if (!workspace) return res.status(503).json({ error: 'Рабочее пространство недоступно' });
      const renamed = await db.renameWorkspace(workspace.id, name);
      if (!renamed) return res.status(400).json({ error: 'Не удалось сохранить название' });
      audit(req, 'team.renamed', { workspace_id: workspace.id }).catch(() => {});
      res.json({ ok: true, ...(await teamState(req.user.uid)) });
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
      const tokenHash = sha256(raw);
      const result = await db.createWorkspaceInvite({
        workspaceId: workspace.id,
        email,
        role,
        tokenHash,
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
      // Ссылка и картинка письма собираются ДО отправки из доверенного origin (appBase защищён от
      // Host-header poisoning) — тот же приём, что у verify/reset.
      const base = appBase(req);
      const link = `${base}/invite?token=${raw}`;
      /* Тема несёт КТО и КУДА: в списке писем это видно ещё до открытия. Имя личного воркспейса —
         это локальная часть email владельца (миграция 010), поэтому у аккаунта без переименования
         они совпадают и тема вырождается в «schulmannn зовёт вас в schulmannn». В этом случае
         говорим просто «в Atlavue» — повтор имени не несёт информации. */
      const inviterName = String(req.user.email).split('@')[0];
      const subject = inviterName === workspace.name
        ? `${inviterName} приглашает вас в Atlavue`
        : `${inviterName} зовёт вас в ${workspace.name}`;
      /* sendEmailDetailed, а не булев sendEmail: приглашение — единственное письмо, чей провал
         видит ЖИВОЙ человек в интерфейсе, и «не ушло» без причины не даёт ему ничего сделать.
         Структурный исход несёт status и имя ошибки Resend (напр. 403 при отправке с песочного
         onboarding@resend.dev на чужой адрес) — его и логируем, и показываем.
         Ключ идемпотентности привязан к ВЫПУЩЕННОМУ токену: повтор с тем же токеном не шлёт
         второе письмо, а перевыпуск (новый токен) — шлёт. */
      const sent = await sendEmailDetailed(
        email,
        subject,
        inviteEmailHtml(link, workspace.name, req.user.email, role, base),
        {
          idempotencyKey: `invite:${result.invite.id}:${tokenHash.slice(0, 16)}`,
          text: inviteEmailText(link, workspace.name, req.user.email, role),
        },
      );
      const delivered = sent.outcome === 'sent';
      audit(req, 'team.invited', { workspace_id: workspace.id, role, reissued: !!result.reissued }).catch(() => {});
      if (!delivered) {
        log('warn', 'team_invite_email_failed', {
          workspace_id: workspace.id,
          invite_id: result.invite.id,
          outcome: sent.outcome,
          status: sent.status || null,
          provider_error: sent.name || sent.reason || null,
        });
      }
      const state = await teamState(req.user.uid);
      res.json({
        ok: true,
        delivered,
        // Причина отказа — для человека у формы: сервер знает её, и молчать о ней нечестно.
        delivery: delivered ? null : { outcome: sent.outcome, status: sent.status || null, error: sent.name || sent.reason || null },
        // Ссылка отдаётся ТОЛЬКО в момент выпуска (сырой токен больше нигде не живёт — в БД
        // только sha256). Владелец сможет передать её мессенджером, если почта подвела.
        invite_link: link,
        invite: result.invite,
        ...state,
      });
    } catch (e) { next(e); }
  });

  /* ── Ссылка на приглашение по требованию ─────────────────────────────────────────────────────
     Запасной путь, когда почта подвела (или её вовсе нет): владелец получает ссылку и передаёт
     её сам. Сырой токен существует ровно один раз — он ушёл в письмо, а в БД лежит только его
     sha256, — поэтому «покажи ссылку ещё раз» физически возможно лишь ВЫПУСКОМ НОВОГО токена.
     Прежняя ссылка из письма при этом умирает; ответ говорит об этом флагом, и UI обязан
     предупредить. Письмо здесь не шлётся: это ручная передача, а не повторная рассылка. */
  app.post('/api/team/invites/:id/link', requireAuth, authLimiter, async (req, res, next) => {
    if (!db.enabled) return dbOff(res);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const workspace = await db.ensureTeamWorkspace(req.user.uid);
      if (!workspace) return res.status(503).json({ error: 'Рабочее пространство недоступно' });
      const raw = newToken();
      const invite = await db.reissueWorkspaceInviteToken(
        workspace.id, id, sha256(raw), new Date(Date.now() + INVITE_TTL));
      if (!invite) return res.status(404).json({ error: 'Приглашение не найдено' });
      audit(req, 'team.invite_link_reissued', { workspace_id: workspace.id, invite_id: id }).catch(() => {});
      res.json({
        ok: true,
        invite_link: `${appBase(req)}/invite?token=${raw}`,
        invite,
        ...(await teamState(req.user.uid)),
      });
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
