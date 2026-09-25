'use strict';

/* ── Team / workspace membership repo ────────────────────────────────────────────────────────────
   Приглашения в воркспейс и управление участниками. До этого раздел «Команда» в /settings был
   витриной: ростер жил в localStorage браузера, письма не уходили, доступ не выдавался. Таблицы
   workspaces/workspace_members существуют с миграции 010 и уже гейтят КАЖДОЕ tenant-чтение
   (db/access.js), но вставка в workspace_members была ровно одна — создатель воркспейса в роли
   'owner'. Этот repo добавляет недостающий путь «пригласить второго».

   ТЕРМИНОЛОГИЯ: `role` здесь — роль В ВОРКСПЕЙСЕ (owner|admin|member|viewer, ранги в
   middleware/tenant.js), НЕ глобальный users.role (user|superuser).

   Владелец воркспейса не приглашается и не удаляется: он приходит из workspaces.owner_uid, а его
   строка в workspace_members всегда role='owner'. Поэтому все методы ниже, меняющие членство,
   несут `AND role <> 'owner'` — единственная защита от «сам себя разжаловал». */

// Жёсткий серверный потолок мест (владелец не в счёт). Тарифный лимит на фронте (lib/plan.ts) —
// UI-превью без оплаты и без серверного смысла, поэтому НЕ он охраняет базу: этот кап держит
// злоупотребление рассылкой в рамках самого щедрого плана.
const MAX_WORKSPACE_SEATS = 10;
// Роли, которые можно ВЫДАТЬ приглашением (owner — только создатель воркспейса).
const INVITE_ROLES = ['admin', 'member', 'viewer'];
// Не чаще одного письма в минуту на (воркспейс, email) — тот же приём, что кулдаун email_tokens:
// повторное «Пригласить» иначе превращается в кнопку почтового флуда по чужому ящику.
const INVITE_COOLDOWN_SECONDS = 60;
// Потолок имени команды. Оно печатается в теме письма и в заголовке — длинное режет вёрстку
// почтового клиента, а не наш CSS, поэтому кап живёт на сервере, а не только в инпуте.
const WORKSPACE_NAME_MAX = 64;

const normalizeEmail = (email) => String(email || '').toLowerCase().trim();

function createTeamRepo({ pool, enabled, transaction, ensurePersonalWorkspace }) {
  // Место, куда приглашают: личный воркспейс приглашающего. Создаётся лениво — у аккаунта без
  // единого подключённого источника строки workspaces ещё нет, а пригласить коллегу он вправе.
  async function ensureTeamWorkspace(uid) {
    if (!enabled || uid == null) return null;
    const wsId = await ensurePersonalWorkspace(uid);
    if (wsId == null) return null;
    const { rows } = await pool.query(
      'SELECT id, name, owner_uid FROM workspaces WHERE id=$1', [wsId]);
    return rows[0] || null;
  }

  /* Переименование команды. Имя воркспейса — ЧИСТО отображаемое: по нему нигде не ищут и ничего
     не связывают (единственные читатели — экран «Команда», превью приглашения, письмо и
     GDPR-экспорт), поэтому смена безопасна и не требует миграции ссылок.
     По умолчанию имя = локальная часть email владельца (миграция 010), из-за чего письмо звало
     «в schulmannn» — этот метод и закрывает тот хвост. */
  async function renameWorkspace(workspaceId, name) {
    if (!enabled || !workspaceId) return null;
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed.length > WORKSPACE_NAME_MAX) return null;
    const { rows } = await pool.query(
      'UPDATE workspaces SET name = $2 WHERE id = $1 RETURNING id, name, owner_uid',
      [workspaceId, trimmed]);
    return rows[0] || null;
  }

  // Участники воркспейса. Владелец первым, дальше в порядке вступления — тот же порядок, что
  // рисует экран «Команда».
  async function listWorkspaceMembers(workspaceId) {
    if (!enabled || !workspaceId) return [];
    const { rows } = await pool.query(
      `SELECT m.uid, u.email, m.role,
              to_char(m.created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
         FROM workspace_members m
         JOIN users u ON u.id = m.uid
        WHERE m.workspace_id = $1
        ORDER BY (m.role = 'owner') DESC, m.created_at ASC, m.uid ASC`, [workspaceId]);
    return rows;
  }

  // Живые (не принятые, не отозванные, не просроченные) приглашения. Просроченные не показываем
  // как «ждёт ответа» — они уже ничего не открывают; строка остаётся в БД как след.
  async function listWorkspaceInvites(workspaceId) {
    if (!enabled || !workspaceId) return [];
    const { rows } = await pool.query(
      `SELECT id, email, role,
              to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
              to_char(expires_at,'YYYY-MM-DD"T"HH24:MI:SS') AS expires_at
         FROM workspace_invites
        WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`, [workspaceId]);
    return rows;
  }

  // Воркспейсы, где пользователь участник, но НЕ владелец. Нужно приглашённому: открыв «Команду»,
  // он иначе видит свой пустой личный воркспейс и не понимает, куда его позвали.
  async function listForeignMemberships(uid) {
    if (!enabled || uid == null) return [];
    const { rows } = await pool.query(
      `SELECT w.id, w.name, m.role, o.email AS owner_email
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         LEFT JOIN users o ON o.id = w.owner_uid
        WHERE m.uid = $1 AND m.role <> 'owner' AND w.owner_uid <> $1
        ORDER BY m.created_at ASC`, [uid]);
    return rows;
  }

  // Занятые места = участники (кроме владельца) + живые приглашения. Считается ОДНИМ запросом,
  // чтобы проверка «влезает ли ещё один» внутри транзакции видела согласованную картину.
  async function countSeats(executor, workspaceId) {
    const { rows } = await executor.query(
      `SELECT (SELECT count(*) FROM workspace_members
                WHERE workspace_id = $1 AND role <> 'owner')
            + (SELECT count(*) FROM workspace_invites
                WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
                  AND expires_at > now()) AS n`, [workspaceId]);
    return Number(rows[0].n);
  }

  async function countWorkspaceSeats(workspaceId) {
    if (!enabled || !workspaceId) return 0;
    return countSeats(pool, workspaceId);
  }

  /* Выпуск приглашения. Всё под advisory-локом (workspace+email) в одной транзакции: две
     параллельные отправки иначе обе проходят проверку кулдауна и уходят двумя письмами с двумя
     живыми токенами. Повторный вызов ПЕРЕВЫПУСКАЕТ ссылку поверх той же строки (partial-unique
     из миграции 037) — старый токен мгновенно мёртв, «отправить ещё раз» не плодит параллельные.
     Возвращает { outcome, ... }: 'created' | 'already_member' | 'cooldown' | 'full'. */
  async function createWorkspaceInvite({ workspaceId, email, role, tokenHash, invitedBy, expiresAt }) {
    if (!enabled || !workspaceId) return { outcome: 'full', limit: MAX_WORKSPACE_SEATS };
    const mail = normalizeEmail(email);
    const inviteRole = INVITE_ROLES.includes(role) ? role : 'member';
    return transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('ws_invite:' || $1::text || ':' || $2))",
        [workspaceId, mail]);

      const member = await client.query(
        `SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.uid
          WHERE m.workspace_id = $1 AND lower(u.email) = $2 LIMIT 1`, [workspaceId, mail]);
      if (member.rows.length) return { outcome: 'already_member', role: member.rows[0].role };

      const pending = await client.query(
        `SELECT id, created_at > now() - make_interval(secs => $3) AS fresh
           FROM workspace_invites
          WHERE workspace_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [workspaceId, mail, INVITE_COOLDOWN_SECONDS]);
      if (pending.rows[0] && pending.rows[0].fresh) return { outcome: 'cooldown' };

      // Перевыпуск уже занятого места нового места не требует — кап проверяем только для новых.
      if (!pending.rows[0] && (await countSeats(client, workspaceId)) >= MAX_WORKSPACE_SEATS) {
        return { outcome: 'full', limit: MAX_WORKSPACE_SEATS };
      }

      const { rows } = await client.query(
        `INSERT INTO workspace_invites (workspace_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (workspace_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL
         DO UPDATE SET role = EXCLUDED.role, token_hash = EXCLUDED.token_hash,
                       invited_by = EXCLUDED.invited_by, expires_at = EXCLUDED.expires_at,
                       created_at = now()
         RETURNING id, email, role,
                   to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
                   to_char(expires_at,'YYYY-MM-DD"T"HH24:MI:SS') AS expires_at`,
        [workspaceId, mail, inviteRole, tokenHash, invitedBy, expiresAt]);
      return { outcome: 'created', invite: rows[0], reissued: !!pending.rows[0] };
    });
  }

  /* Превью приглашения по хешу токена (страница /invite до входа). Отдаёт только то, что уже
     знает получатель письма: свой email, имя воркспейса и кто позвал. `status` отделяет «ссылка
     мертва» от «ссылка жива», чтобы страница не предлагала завести аккаунт впустую. */
  async function getWorkspaceInviteByToken(tokenHash) {
    if (!enabled || !tokenHash) return null;
    const { rows } = await pool.query(
      `SELECT i.id, i.email, i.role, i.accepted_at, i.revoked_at,
              i.expires_at <= now() AS expired,
              i.link_exposed_at IS NOT NULL AS link_exposed,
              w.name AS workspace_name,
              inviter.email AS invited_by_email,
              (SELECT u.status FROM users u WHERE lower(u.email) = i.email) AS invitee_status
         FROM workspace_invites i
         JOIN workspaces w ON w.id = i.workspace_id
         LEFT JOIN users inviter ON inviter.id = i.invited_by
        WHERE i.token_hash = $1`, [tokenHash]);
    const row = rows[0];
    if (!row) return null;
    const status = row.revoked_at ? 'revoked'
      : row.accepted_at ? 'accepted'
      : row.expired ? 'expired'
      : 'live';
    return {
      status,
      email: row.email,
      role: row.role,
      workspace_name: row.workspace_name,
      invited_by_email: row.invited_by_email,
      // Сырую ссылку хоть раз показывали инициатору → доставка письма больше не доказывает, что
      // её открыл владелец ящика. Такой приём обязан идти через подтверждение почты (H-1).
      link_exposed: row.link_exposed === true,
      // Есть ли уже аккаунт с этим email и в каком он статусе — страница по этому решает,
      // просить пароль (аккаунта нет) или отправить входить (аккаунт есть).
      invitee_status: row.invitee_status || null,
    };
  }

  /* Приём приглашения: строка блокируется FOR UPDATE, все проверки живости — внутри транзакции,
     так что двойной клик не может принять дважды. Email сверяется со СВОИМ (владение ящиком
     доказано доставкой письма, но сессия может быть чужой) — иначе пересланная ссылка пускала бы
     любого. `ON CONFLICT DO UPDATE ... WHERE role <> 'owner'` защищает владельца от разжалования,
     если он каким-то путём принял приглашение в собственный воркспейс.
     Возвращает { outcome }: 'accepted' | 'invalid' | 'revoked' | 'already_accepted' | 'expired' |
     'email_mismatch'. */
  async function acceptWorkspaceInvite({ tokenHash, uid, email }) {
    if (!enabled || !tokenHash || uid == null) return { outcome: 'invalid' };
    const mine = normalizeEmail(email);
    return transaction(async (client) => {
      const { rows } = await client.query(
        `SELECT i.id, i.workspace_id, i.email, i.role, i.accepted_at, i.revoked_at,
                i.expires_at <= now() AS expired, w.name AS workspace_name
           FROM workspace_invites i
           JOIN workspaces w ON w.id = i.workspace_id
          WHERE i.token_hash = $1
          FOR UPDATE OF i`, [tokenHash]);
      const invite = rows[0];
      if (!invite) return { outcome: 'invalid' };
      if (invite.revoked_at) return { outcome: 'revoked' };
      if (invite.accepted_at) return { outcome: 'already_accepted' };
      if (invite.expired) return { outcome: 'expired' };
      if (invite.email !== mine) return { outcome: 'email_mismatch', email: invite.email };

      await client.query(
        `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1,$2,$3)
         ON CONFLICT (workspace_id, uid)
         DO UPDATE SET role = EXCLUDED.role WHERE workspace_members.role <> 'owner'`,
        [invite.workspace_id, uid, invite.role]);
      await client.query(
        'UPDATE workspace_invites SET accepted_at = now(), accepted_uid = $2 WHERE id = $1',
        [invite.id, uid]);
      return {
        outcome: 'accepted',
        workspace_id: invite.workspace_id,
        workspace_name: invite.workspace_name,
        role: invite.role,
      };
    });
  }

  /* Перевыпуск токена ЖИВОГО приглашения без письма — под кнопку «Скопировать ссылку».
     Нужен потому, что сырой токен существует ровно один раз: в БД лежит только его sha256, а сам
     он уходит в письмо и больше нигде не хранится. Значит «дай мне ссылку ещё раз» физически
     возможно только выпуском НОВОГО токена — прежняя ссылка из письма при этом умирает, и UI
     обязан сказать это вслух. Срок жизни отсчитывается заново.
     Кулдаун здесь НЕ применяется: он охраняет почтовый флуд по чужому ящику, а этот путь писем
     не шлёт. Скоупится воркспейсом — чужое приглашение по id не перевыпускается. */
  async function reissueWorkspaceInviteToken(workspaceId, inviteId, tokenHash, expiresAt) {
    if (!enabled || !workspaceId || !inviteId) return null;
    const { rows } = await pool.query(
      `UPDATE workspace_invites
          SET token_hash = $3, expires_at = $4, link_exposed_at = COALESCE(link_exposed_at, now())
        WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING id, email, role,
                  to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
                  to_char(expires_at,'YYYY-MM-DD"T"HH24:MI:SS') AS expires_at`,
      [inviteId, workspaceId, tokenHash, expiresAt]);
    return rows[0] || null;
  }

  /* Пометка «сырая ссылка ушла инициатору». Ставится ОДИН раз (первое раскрытие) и больше не
     двигается: важна не последняя дата, а сам факт — приглашение уже нельзя считать доказательством
     владения ящиком. Перевыпуск ссылки помечает себя сам, внутри своего UPDATE. */
  async function markInviteLinkExposed(workspaceId, inviteId) {
    if (!enabled || !workspaceId || !inviteId) return false;
    const { rowCount } = await pool.query(
      `UPDATE workspace_invites SET link_exposed_at = now()
        WHERE id = $1 AND workspace_id = $2 AND link_exposed_at IS NULL`,
      [inviteId, workspaceId]);
    return rowCount > 0;
  }

  // Отзыв приглашения (ссылка из письма умирает немедленно). Скоупится воркспейсом — чужое
  // приглашение по id не отзывается.
  async function revokeWorkspaceInvite(workspaceId, inviteId) {
    if (!enabled || !workspaceId || !inviteId) return false;
    const { rowCount } = await pool.query(
      `UPDATE workspace_invites SET revoked_at = now()
        WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [inviteId, workspaceId]);
    return rowCount > 0;
  }

  async function setWorkspaceMemberRole(workspaceId, uid, role) {
    if (!enabled || !workspaceId || uid == null) return false;
    if (!INVITE_ROLES.includes(role)) throw new Error('bad workspace role');
    const { rowCount } = await pool.query(
      `UPDATE workspace_members SET role = $3
        WHERE workspace_id = $1 AND uid = $2 AND role <> 'owner'`, [workspaceId, uid, role]);
    return rowCount > 0;
  }

  async function removeWorkspaceMember(workspaceId, uid) {
    if (!enabled || !workspaceId || uid == null) return false;
    const { rowCount } = await pool.query(
      `DELETE FROM workspace_members
        WHERE workspace_id = $1 AND uid = $2 AND role <> 'owner'`, [workspaceId, uid]);
    return rowCount > 0;
  }

  return {
    MAX_WORKSPACE_SEATS, INVITE_ROLES, INVITE_COOLDOWN_SECONDS, WORKSPACE_NAME_MAX,
    ensureTeamWorkspace, renameWorkspace, listWorkspaceMembers, listWorkspaceInvites, listForeignMemberships,
    countWorkspaceSeats, createWorkspaceInvite, getWorkspaceInviteByToken, acceptWorkspaceInvite,
    reissueWorkspaceInviteToken, markInviteLinkExposed, revokeWorkspaceInvite, setWorkspaceMemberRole,
    removeWorkspaceMember,
  };
}

module.exports = { createTeamRepo };
