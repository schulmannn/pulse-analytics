import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { purgeLegacySession } from './session';

/** Тестовая среда без DOM — localStorage подставляется вручную (как было и до правки). */
class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * От моста до-cookie-сессии осталась одна уборка.
 *
 * Сам мост (заголовочный токен → одноразовый роут обмена на cookie) снят: его критерий удаления —
 * «семь дней после первого деплоя» — наступил в июле, а прожил он до сентября (аудит #554).
 * Читаемый из JS токен в localStorage без работающего моста — это уже не мост, а просто лежащий
 * секрет, поэтому уборка осталась и обязана быть безусловной и безопасной при любом состоянии
 * хранилища.
 */
describe('purgeLegacySession', () => {
  it('сносит оба ключа старого транспорта', () => {
    localStorage.setItem('pulse_token', 'old-browser-token');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60_000));
    purgeLegacySession();
    expect(localStorage.getItem('pulse_token')).toBeNull();
    expect(localStorage.getItem('pulse_token_exp')).toBeNull();
  });

  it('сносит и просроченный токен — срок тут ни при чём', () => {
    localStorage.setItem('pulse_token', 'expired');
    localStorage.setItem('pulse_token_exp', String(Date.now() - 1));
    purgeLegacySession();
    expect(localStorage.getItem('pulse_token')).toBeNull();
  });

  it('идемпотентна и не трогает чужие ключи', () => {
    localStorage.setItem('pulse_theme', 'dark');
    purgeLegacySession();
    purgeLegacySession();
    expect(localStorage.getItem('pulse_theme')).toBe('dark');
  });

  it('недоступное хранилище не роняет загрузку приложения', () => {
    // Приватное окно / отключённые site data: уборка вызывается в bootstrap ДО первого рендера,
    // и брошенное отсюда исключение оставило бы пользователя с пустым экраном.
    vi.stubGlobal('localStorage', {
      removeItem() { throw new Error('SecurityError'); },
    });
    expect(() => purgeLegacySession()).not.toThrow();
  });
});
