import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, getTeam, isValidEmail, removeMember, setMemberRole, TEAM_LIMIT } from './team';

// Node test environment — minimal in-memory localStorage for the store.
beforeAll(() => {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
  };
});

describe('team store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty and adds a member', () => {
    expect(getTeam()).toEqual([]);
    expect(addMember('Anna@Example.com', 'editor')).toBeNull();
    expect(getTeam()).toEqual([{ email: 'anna@example.com', role: 'editor' }]);
  });

  it('rejects invalid emails and duplicates', () => {
    expect(addMember('not-an-email', 'viewer')).toBe('Похоже, это не email');
    addMember('a@b.co', 'viewer');
    expect(addMember(' A@B.CO ', 'editor')).toBe('Уже в списке');
    expect(getTeam()).toHaveLength(1);
  });

  it('updates a role and removes a member', () => {
    addMember('a@b.co', 'viewer');
    setMemberRole('a@b.co', 'editor');
    expect(getTeam()[0].role).toBe('editor');
    removeMember('a@b.co');
    expect(getTeam()).toEqual([]);
  });

  it('survives garbage in storage', () => {
    localStorage.setItem('pulse_team', '{"broken":');
    expect(getTeam()).toEqual([]);
    localStorage.setItem('pulse_team', JSON.stringify([{ email: 'x@y.zz', role: 'admin' }, { email: 'ok@y.zz', role: 'viewer' }]));
    expect(getTeam()).toEqual([{ email: 'ok@y.zz', role: 'viewer' }]);
  });

  it('email validation covers the basics', () => {
    expect(isValidEmail('user@mail.ru')).toBe(true);
    expect(isValidEmail('user@mail')).toBe(false);
    expect(isValidEmail('@mail.ru')).toBe(false);
    expect(isValidEmail('u ser@mail.ru')).toBe(false);
  });

  it('plan limits are sane', () => {
    expect(TEAM_LIMIT.free).toBe(0);
    expect(TEAM_LIMIT.pro).toBeGreaterThan(0);
    expect(TEAM_LIMIT.max).toBeGreaterThan(TEAM_LIMIT.pro);
  });
});
