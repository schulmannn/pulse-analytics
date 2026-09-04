import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Каждое ОТКЛЮЧЕНИЕ ИСТОЧНИКА обязано спрашивать подтверждение.
 *
 * Статический гейт, а не рендер-тест: проблема была не в одном сломанном обработчике, а в том, что
 * их четыре в файле на 1900 строк и ни один не спрашивал. Такое ловится только правилом «ни одного
 * без confirm», и правило должно пережить добавление пятого источника.
 *
 * Цена промаха разная, но необратимость общая: у МойСклада и Метрики удаляется токен (возвращаться
 * за ним в чужой кабинет), у Instagram отзывается OAuth, а managed QR-сессия Telegram ОБЩАЯ для
 * всех каналов владельца и восстанавливается только повторным входом с телефона — поэтому у неё
 * усиленный type-to-confirm.
 */
const SRC = readFileSync(new URL('./Connect.tsx', import.meta.url), 'utf8');

describe('отключение источника на /connect', () => {
  it('каждый DELETE-эндпоинт отключения прикрыт подтверждением', () => {
    const endpoints = ['/api/ms/account', '/api/ym/account', '/api/tg/qr/session'];
    for (const endpoint of endpoints) {
      const at = SRC.indexOf(endpoint);
      expect(at, `${endpoint} должен существовать`).toBeGreaterThan(0);
      // confirm вызывается ВЫШЕ по тому же обработчику — ищем в окне перед вызовом.
      const before = SRC.slice(Math.max(0, at - 1400), at);
      expect(before, `${endpoint} без подтверждения`).toMatch(/await confirm\(\{/);
    }
  });

  it('Instagram-отключение тоже спрашивает', () => {
    const at = SRC.indexOf('disconnect.mutate(');
    expect(at).toBeGreaterThan(0);
    expect(SRC.slice(Math.max(0, at - 900), at)).toMatch(/await confirm\(\{/);
  });

  // Общая сессия — единственное необратимое действие: её нельзя переполучить программно.
  it('обрыв managed QR-сессии требует type-to-confirm, а не одного клика', () => {
    const at = SRC.indexOf('/api/tg/qr/session');
    const before = SRC.slice(Math.max(0, at - 1400), at);
    expect(before).toMatch(/typeToConfirm:/);
  });

  it('каждое подтверждение объясняет последствие, а не только спрашивает', () => {
    const reasons = SRC.match(/reason: '[^']{40,}'/g) ?? [];
    expect(reasons.length, 'у всех четырёх отключений должен быть reason').toBeGreaterThanOrEqual(4);
  });

  it('в файле не осталось нативного window.confirm', () => {
    expect(SRC).not.toMatch(/\bwindow\.confirm\(/);
  });
});
