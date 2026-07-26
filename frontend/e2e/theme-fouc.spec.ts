import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Тема обязана стоять на <html> ДО первого кадра. ThemeProvider применяет её из useEffect, т.е.
 * после первого paint — на сохранённой/системной тёмной теме первый кадр был светлым (FOUC).
 * Прерисовочный бутстрап живёт в public/theme-boot.js и подключён классическим <script> в
 * index.html (инлайн запрещён строгим CSP `script-src 'self'` без nonce).
 *
 * Доказательство «до первого кадра», а не «быстро после»: entry-модуль приложения блокируется на
 * сетевом уровне. React не грузится вовсе, #root остаётся пустым — и если .dark всё равно стоит,
 * поставить его мог ТОЛЬКО бутстрап из <head>.
 */
test.describe('prepaint theme bootstrap', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'тема не зависит от брейкпоинта');
    // Приложение не грузим: проверяем ровно то, что успевает сделать <head>.
    await page.route('**/src/main.tsx*', (r) => r.abort());
  });

  test('сохранённая тёмная тема стоит на <html> без загрузки бандла', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pulse_theme', 'dark'));
    await page.goto('/', { waitUntil: 'commit' });

    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(true);
    const state = await page.evaluate(() => ({
      colorScheme: document.documentElement.style.colorScheme,
      rootMarkup: document.getElementById('root')?.innerHTML ?? null,
    }));
    expect(state.colorScheme).toBe('dark');
    // Пустой #root — приложение действительно не рендерилось, класс поставил бутстрап.
    expect(state.rootMarkup).toBe('');
  });

  test('сохранённая светлая тема не темнит документ даже при тёмной системной', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => localStorage.setItem('pulse_theme', 'light'));
    await page.goto('/', { waitUntil: 'commit' });

    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light');
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);
  });

  test("режим 'system' (дефолт без записи) следует системной схеме", async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/', { waitUntil: 'commit' });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(true);
  });
});

test('ThemeProvider после гидрации не спорит с уже выставленным классом', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'тема не зависит от брейкпоинта');
  await bootDemo(page, '/', { theme: 'dark' });
  // Приложение смонтировано (bootDemo дожидается shell) — класс и color-scheme остались тёмными.
  const state = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    colorScheme: document.documentElement.style.colorScheme,
  }));
  expect(state).toEqual({ dark: true, colorScheme: 'dark' });
});
