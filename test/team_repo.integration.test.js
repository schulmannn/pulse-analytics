'use strict';

// Integration-тесты teamRepo (приглашения в воркспейс, миграция 037) — на РЕАЛЬНОМ Postgres.
// Проверяется ровно то, что ломается молча и дорого: живость токена, совпадение email, потолок
// мест, кулдаун писем и неприкосновенность владельца. Без TEST_DATABASE_URL всё SKIP. Гоняется
// в CI (postgres) и локально:
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `team${Date.now().toString(36)}${process.pid}`;
let seq = 0;
const mail = (tag) => `${tag}.${seq++}.${nonce}@it.local`;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const inHours = (h) => new Date(Date.now() + h * 3600_000);

const mkUser = (tag) => db.createUser({ email: mail(tag), pass_hash: 'x', role: 'user', status: 'active' });

// Приглашение с уникальным сырым токеном — возвращает и токен, и исход выпуска.
async function invite(wsId, email, role, { by = null, expiresAt = inHours(24) } = {}) {
  const raw = `${nonce}-${seq++}`;
  const result = await db.createWorkspaceInvite({
    workspaceId: wsId, email, role, tokenHash: sha256(raw), invitedBy: by, expiresAt,
  });
  return { raw, result };
}

// Кулдаун — 60 секунд по created_at; тест не спит, а состаривает строку.
const ageInvite = (id, seconds) =>
  pool.query(`UPDATE workspace_invites SET created_at = now() - make_interval(secs => $2) WHERE id = $1`, [id, seconds]);

test.before(() => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  // users каскадят workspaces → workspace_members / workspace_invites.
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.end();
});

test('ensureTeamWorkspace: личный воркспейс создаётся лениво и он же возвращается повторно', { skip }, async () => {
  const owner = await mkUser('ws');
  const first = await db.ensureTeamWorkspace(owner.id);
  assert.ok(first && first.id, 'воркспейс создан для аккаунта без единого источника');
  assert.strictEqual(first.owner_uid, owner.id);
  const second = await db.ensureTeamWorkspace(owner.id);
  assert.strictEqual(second.id, first.id, 'повторный вызов не плодит второй воркспейс');

  const members = await db.listWorkspaceMembers(first.id);
  assert.strictEqual(members.length, 1);
  assert.strictEqual(members[0].role, 'owner');
  assert.strictEqual(await db.countWorkspaceSeats(first.id), 0, 'владелец места не занимает');
});

test('переименование команды: имя доезжает до приглашённого и в превью ссылки', { skip }, async () => {
  const owner = await mkUser('rename');
  const ws = await db.ensureTeamWorkspace(owner.id);
  assert.strictEqual(ws.name, owner.email.split('@')[0], 'по умолчанию имя = локальная часть email');

  assert.strictEqual(await db.renameWorkspace(ws.id, '   '), null, 'пустое имя не сохраняется');
  assert.strictEqual(
    await db.renameWorkspace(ws.id, 'x'.repeat(db.WORKSPACE_NAME_MAX + 1)), null,
    'имя длиннее капа не сохраняется');
  assert.strictEqual((await db.ensureTeamWorkspace(owner.id)).name, ws.name, 'отказы имя не тронули');

  const renamed = await db.renameWorkspace(ws.id, '  Нотем  ');
  assert.strictEqual(renamed.name, 'Нотем', 'пробелы по краям срезаются');

  // Имя — то, что видит приглашённый: и в превью ссылки, и в строке членства.
  const guestMail = mail('renamed');
  const inv = await invite(ws.id, guestMail, 'viewer', { by: owner.id });
  assert.strictEqual((await db.getWorkspaceInviteByToken(sha256(inv.raw))).workspace_name, 'Нотем');

  const guest = await db.createUser({ email: guestMail, pass_hash: 'x', role: 'user', status: 'active' });
  await db.acceptWorkspaceInvite({ tokenHash: sha256(inv.raw), uid: guest.id, email: guestMail });
  assert.strictEqual((await db.listForeignMemberships(guest.id))[0].name, 'Нотем');
});

test('полный круг: приглашение → приём → участник с ролью из приглашения', { skip }, async () => {
  const owner = await mkUser('o');
  const ws = await db.ensureTeamWorkspace(owner.id);
  const guestMail = mail('guest');
  const { raw, result } = await invite(ws.id, guestMail, 'member', { by: owner.id });
  assert.strictEqual(result.outcome, 'created');
  assert.strictEqual(await db.countWorkspaceSeats(ws.id), 1, 'живое приглашение занимает место');

  const preview = await db.getWorkspaceInviteByToken(sha256(raw));
  assert.strictEqual(preview.status, 'live');
  assert.strictEqual(preview.email, guestMail);
  assert.strictEqual(preview.invited_by_email, owner.email);
  assert.strictEqual(preview.invitee_status, null, 'аккаунта ещё нет → страница вправе просить пароль');

  const guest = await db.createUser({ email: guestMail, pass_hash: 'x', role: 'user', status: 'active' });
  const accepted = await db.acceptWorkspaceInvite({ tokenHash: sha256(raw), uid: guest.id, email: guestMail });
  assert.strictEqual(accepted.outcome, 'accepted');
  assert.strictEqual(accepted.role, 'member');

  const members = await db.listWorkspaceMembers(ws.id);
  assert.deepStrictEqual(members.map((m) => m.role), ['owner', 'member'], 'владелец первым, приглашённый следом');
  assert.strictEqual(await db.countWorkspaceSeats(ws.id), 1, 'принятое приглашение не удваивает место');
  assert.strictEqual((await db.listWorkspaceInvites(ws.id)).length, 0, 'принятое приглашение уходит из «ждёт ответа»');

  // Повторный клик по той же ссылке (второе устройство / двойной клик) не принимает дважды.
  const again = await db.acceptWorkspaceInvite({ tokenHash: sha256(raw), uid: guest.id, email: guestMail });
  assert.strictEqual(again.outcome, 'already_accepted');
});

test('приглашение именное: чужая сессия его не примет', { skip }, async () => {
  const owner = await mkUser('o2');
  const ws = await db.ensureTeamWorkspace(owner.id);
  const stranger = await mkUser('stranger');
  const { raw } = await invite(ws.id, mail('target'), 'viewer', { by: owner.id });

  const r = await db.acceptWorkspaceInvite({ tokenHash: sha256(raw), uid: stranger.id, email: stranger.email });
  assert.strictEqual(r.outcome, 'email_mismatch', 'пересланная ссылка не пускает получателя-самозванца');
  assert.strictEqual((await db.listWorkspaceMembers(ws.id)).length, 1, 'состав не изменился');
});

test('мёртвые ссылки: просроченная и отозванная', { skip }, async () => {
  const owner = await mkUser('o3');
  const ws = await db.ensureTeamWorkspace(owner.id);

  const expiredMail = mail('exp');
  const expired = await invite(ws.id, expiredMail, 'viewer', { by: owner.id, expiresAt: inHours(-1) });
  assert.strictEqual((await db.getWorkspaceInviteByToken(sha256(expired.raw))).status, 'expired');
  const u1 = await db.createUser({ email: expiredMail, pass_hash: 'x', role: 'user', status: 'active' });
  assert.strictEqual(
    (await db.acceptWorkspaceInvite({ tokenHash: sha256(expired.raw), uid: u1.id, email: expiredMail })).outcome,
    'expired');
  assert.strictEqual((await db.listWorkspaceInvites(ws.id)).length, 0, 'просроченное не висит как «ждёт ответа»');
  assert.strictEqual(await db.countWorkspaceSeats(ws.id), 0, 'просроченное не держит место');

  const revokedMail = mail('rev');
  const revoked = await invite(ws.id, revokedMail, 'viewer', { by: owner.id });
  assert.strictEqual(await db.revokeWorkspaceInvite(ws.id, revoked.result.invite.id), true);
  assert.strictEqual((await db.getWorkspaceInviteByToken(sha256(revoked.raw))).status, 'revoked');
  const u2 = await db.createUser({ email: revokedMail, pass_hash: 'x', role: 'user', status: 'active' });
  assert.strictEqual(
    (await db.acceptWorkspaceInvite({ tokenHash: sha256(revoked.raw), uid: u2.id, email: revokedMail })).outcome,
    'revoked');

  // Отзыв чужого приглашения по id не проходит — операция скоупится воркспейсом.
  const other = await mkUser('o3b');
  const otherWs = await db.ensureTeamWorkspace(other.id);
  const mine = await invite(ws.id, mail('mine'), 'viewer', { by: owner.id });
  assert.strictEqual(await db.revokeWorkspaceInvite(otherWs.id, mine.result.invite.id), false);
});

test('повторное «Пригласить»: кулдаун, затем перевыпуск поверх той же строки', { skip }, async () => {
  const owner = await mkUser('o4');
  const ws = await db.ensureTeamWorkspace(owner.id);
  const target = mail('again');
  const first = await invite(ws.id, target, 'viewer', { by: owner.id });

  const tooSoon = await invite(ws.id, target, 'viewer', { by: owner.id });
  assert.strictEqual(tooSoon.result.outcome, 'cooldown', 'минутный кулдаун гасит почтовый флуд');

  await ageInvite(first.result.invite.id, 120);
  const reissued = await invite(ws.id, target, 'admin', { by: owner.id });
  assert.strictEqual(reissued.result.outcome, 'created');
  assert.strictEqual(reissued.result.reissued, true);
  assert.strictEqual(reissued.result.invite.id, first.result.invite.id, 'перевыпуск идёт поверх той же строки');
  assert.strictEqual(reissued.result.invite.role, 'admin', 'роль перевыпуска обновилась');
  assert.strictEqual(await db.getWorkspaceInviteByToken(sha256(first.raw)), null, 'старый токен мёртв');
  assert.strictEqual((await db.getWorkspaceInviteByToken(sha256(reissued.raw))).status, 'live');
  assert.strictEqual((await db.listWorkspaceInvites(ws.id)).length, 1, 'параллельных приглашений не появилось');
});

test('уже участник + потолок мест', { skip }, async () => {
  const owner = await mkUser('o5');
  const ws = await db.ensureTeamWorkspace(owner.id);
  const guestMail = mail('inside');
  const guest = await db.createUser({ email: guestMail, pass_hash: 'x', role: 'user', status: 'active' });
  const joined = await invite(ws.id, guestMail, 'member', { by: owner.id });
  await db.acceptWorkspaceInvite({ tokenHash: sha256(joined.raw), uid: guest.id, email: guestMail });

  const dup = await invite(ws.id, guestMail.toUpperCase(), 'admin', { by: owner.id });
  assert.strictEqual(dup.result.outcome, 'already_member', 'email сверяется регистронезависимо');

  // Добиваем места до серверного капа: один участник уже внутри, значит нужно limit-1 приглашений.
  const limit = db.MAX_WORKSPACE_SEATS;
  for (let i = 1; i < limit; i += 1) {
    const r = await invite(ws.id, mail(`bulk${i}`), 'viewer', { by: owner.id });
    assert.strictEqual(r.result.outcome, 'created', `место ${i + 1} должно быть свободно`);
  }
  assert.strictEqual(await db.countWorkspaceSeats(ws.id), limit);
  const overflow = await invite(ws.id, mail('overflow'), 'viewer', { by: owner.id });
  assert.strictEqual(overflow.result.outcome, 'full');
  assert.strictEqual(overflow.result.limit, limit);
});

test('перевыпуск ссылки: старый токен умирает, новый живёт, чужой воркспейс не трогается', { skip }, async () => {
  const owner = await mkUser('link');
  const ws = await db.ensureTeamWorkspace(owner.id);
  const target = mail('link');
  const first = await invite(ws.id, target, 'viewer', { by: owner.id });

  // Кулдаун на перевыпуск НЕ распространяется: письма этот путь не шлёт.
  const rawNew = `${nonce}-relink`;
  const reissued = await db.reissueWorkspaceInviteToken(
    ws.id, first.result.invite.id, sha256(rawNew), inHours(24));
  assert.ok(reissued, 'перевыпуск живого приглашения проходит');
  assert.strictEqual(reissued.id, first.result.invite.id, 'та же строка, не новая');
  assert.strictEqual(reissued.email, target);
  assert.strictEqual(await db.getWorkspaceInviteByToken(sha256(first.raw)), null, 'прежняя ссылка мертва');
  assert.strictEqual((await db.getWorkspaceInviteByToken(sha256(rawNew))).status, 'live');
  assert.strictEqual(await db.countWorkspaceSeats(ws.id), 1, 'перевыпуск не съедает второе место');

  // Чужой воркспейс по id не перевыпускает.
  const other = await mkUser('link2');
  const otherWs = await db.ensureTeamWorkspace(other.id);
  assert.strictEqual(
    await db.reissueWorkspaceInviteToken(otherWs.id, first.result.invite.id, sha256('x'), inHours(24)),
    null, 'приглашение чужого воркспейса не перевыпускается');
  assert.strictEqual((await db.getWorkspaceInviteByToken(sha256(rawNew))).status, 'live', 'токен не тронут');

  // Отозванное и принятое приглашение ссылку не отдают.
  await db.revokeWorkspaceInvite(ws.id, first.result.invite.id);
  assert.strictEqual(
    await db.reissueWorkspaceInviteToken(ws.id, first.result.invite.id, sha256('y'), inHours(24)),
    null, 'отозванное приглашение не оживает перевыпуском');
});

test('владелец неприкосновенен: роль не понижается, строка не удаляется', { skip }, async () => {
  const owner = await mkUser('o6');
  const ws = await db.ensureTeamWorkspace(owner.id);

  assert.strictEqual(await db.setWorkspaceMemberRole(ws.id, owner.id, 'viewer'), false);
  assert.strictEqual(await db.removeWorkspaceMember(ws.id, owner.id), false);
  const members = await db.listWorkspaceMembers(ws.id);
  assert.deepStrictEqual(members.map((m) => m.role), ['owner']);

  // Обычным путём приглашение на самого себя не выписывается вовсе — владелец уже участник.
  const self = await invite(ws.id, owner.email, 'viewer', { by: owner.id });
  assert.strictEqual(self.result.outcome, 'already_member');

  // Вторая линия обороны (ON CONFLICT ... WHERE role <> 'owner'): даже если строка приглашения
  // на владельца появится в обход выпуска, приём НЕ понизит его до viewer. Пишем такую строку
  // напрямую в БД — иначе этот guard ничем не покрыт.
  const rawDirect = `${nonce}-owner-direct`;
  await pool.query(
    `INSERT INTO workspace_invites (workspace_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1,$2,'viewer',$3,$4, now() + interval '1 day')`,
    [ws.id, owner.email, sha256(rawDirect), owner.id]);
  const r = await db.acceptWorkspaceInvite({ tokenHash: sha256(rawDirect), uid: owner.id, email: owner.email });
  assert.strictEqual(r.outcome, 'accepted');
  const after = await db.listWorkspaceMembers(ws.id);
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].role, 'owner', 'ON CONFLICT не понизил владельца до viewer');
});

test('смена роли и исключение участника; listForeignMemberships показывает чужой воркспейс', { skip }, async () => {
  const owner = await mkUser('o7');
  const ws = await db.ensureTeamWorkspace(owner.id);
  const guestMail = mail('member');
  const guest = await db.createUser({ email: guestMail, pass_hash: 'x', role: 'user', status: 'active' });
  const inv = await invite(ws.id, guestMail, 'viewer', { by: owner.id });
  await db.acceptWorkspaceInvite({ tokenHash: sha256(inv.raw), uid: guest.id, email: guestMail });

  const foreign = await db.listForeignMemberships(guest.id);
  assert.strictEqual(foreign.length, 1);
  assert.strictEqual(foreign[0].id, ws.id);
  assert.strictEqual(foreign[0].role, 'viewer');
  assert.strictEqual(foreign[0].owner_email, owner.email);
  assert.strictEqual((await db.listForeignMemberships(owner.id)).length, 0, 'свой воркспейс в «чужие» не попадает');

  assert.strictEqual(await db.setWorkspaceMemberRole(ws.id, guest.id, 'admin'), true);
  assert.strictEqual((await db.listWorkspaceMembers(ws.id))[1].role, 'admin');
  await assert.rejects(() => db.setWorkspaceMemberRole(ws.id, guest.id, 'owner'), /bad workspace role/,
    'роль owner через этот путь не выдаётся');

  assert.strictEqual(await db.removeWorkspaceMember(ws.id, guest.id), true);
  assert.strictEqual((await db.listWorkspaceMembers(ws.id)).length, 1);
  assert.strictEqual((await db.listForeignMemberships(guest.id)).length, 0, 'доступ пропал вместе со строкой членства');
});
