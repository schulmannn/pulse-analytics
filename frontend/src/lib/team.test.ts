import { describe, expect, it } from 'vitest';
import { INVITE_ROLES, isValidEmail, ROLE_HINT, ROLE_LABEL, TEAM_LIMIT, type MemberRole } from './team';

// Ростер переехал на сервер (`/api/team`), здесь остался словарь ролей. Тесты держат ровно те
// инварианты, которые ломаются молча: несовпадение с ролями БД и подпись, которой нет.
describe('team vocabulary', () => {
  it('приглашением выдаются все роли БД, кроме owner', () => {
    expect([...INVITE_ROLES].sort()).toEqual(['admin', 'member', 'viewer']);
    expect(INVITE_ROLES).not.toContain('owner' as never);
  });

  it('у каждой роли есть подпись, у приглашаемых — ещё и пояснение', () => {
    const all: MemberRole[] = ['owner', ...INVITE_ROLES];
    for (const role of all) expect(ROLE_LABEL[role]).toBeTruthy();
    for (const role of INVITE_ROLES) expect(ROLE_HINT[role]).toBeTruthy();
  });

  it('plan limits are sane', () => {
    expect(TEAM_LIMIT.free).toBe(0);
    expect(TEAM_LIMIT.pro).toBeGreaterThan(0);
    expect(TEAM_LIMIT.max).toBeGreaterThan(TEAM_LIMIT.pro);
  });

  it('email validation covers the basics', () => {
    expect(isValidEmail('user@mail.ru')).toBe(true);
    expect(isValidEmail('user@mail')).toBe(false);
    expect(isValidEmail('@mail.ru')).toBe(false);
    expect(isValidEmail('u ser@mail.ru')).toBe(false);
  });
});
