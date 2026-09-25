import type { PlanId } from '@/lib/plan';

/**
 * Словарь ролей воркспейса. Раньше этот модуль ДЕРЖАЛ ростер в localStorage (приглашения были
 * витриной: письма не уходили, доступ не выдавался). Теперь команда живёт на сервере
 * (`/api/team`, таблицы workspace_members / workspace_invites), а здесь остаётся только
 * вокабуляр — как называется каждая роль и сколько мест продаёт тариф.
 *
 * Идентификаторы ролей ТЕ ЖЕ, что в БД и в рангах `middleware/tenant.js`
 * (viewer < member < admin < owner) — общий словарь без переводной прослойки на границе API.
 */
export type TeamRole = 'admin' | 'member' | 'viewer';

/** Роль владельца воркспейса. Не выдаётся приглашением — приходит из workspaces.owner_uid. */
export type MemberRole = TeamRole | 'owner';

export const ROLE_LABEL: Record<MemberRole, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  member: 'Редактор',
  viewer: 'Наблюдатель',
};

/** Что роль реально может — подсказка под выбором, а не догадка пользователя. */
export const ROLE_HINT: Record<TeamRole, string> = {
  admin: 'Управляет источниками и ключами',
  member: 'Смотрит данные и ведёт заметки',
  viewer: 'Только просмотр',
};

/** Роли, которые можно выдать приглашением (порядок — от меньших прав к большим). */
export const INVITE_ROLES: TeamRole[] = ['viewer', 'member', 'admin'];

/**
 * Мест для КОЛЛЕГ по тарифу (владелец не в счёт). Тариф — клиентское превью (см. lib/plan.ts):
 * доступ он не охраняет, это витрина. Настоящий потолок — серверный `seats.limit`
 * (`MAX_WORKSPACE_SEATS` в repos/teamRepo.js), он и отказывает в приглашении.
 */
export const TEAM_LIMIT: Record<PlanId, number> = { free: 0, pro: 3, max: 10 };

export const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
