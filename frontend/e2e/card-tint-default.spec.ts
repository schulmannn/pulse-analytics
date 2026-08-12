import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Дефолтная тонировка доски: цвет = идентичность серии, а заливка — ручной инструмент ОДНОЙ
 * истории (DESIGN_TOKENS.md «Surface & width policy»). Раньше свежий профиль получал сразу пять
 * разноцветных заливок на Обзоре, и цвет переставал что-либо значить.
 *
 * Свежий контекст Playwright = пустой `pulse_widget_prefs`, т.е. проверяются именно ДЕФОЛТЫ;
 * сохранённый выбор пользователя главнее и покрыт юнитом (`widgetSurface.test.ts`).
 */
test('на свежем Обзоре тонирована ровно одна карточка', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'дефолты доски — desktop-хром');
  await bootDemo(page, '/');

  const hero = page.locator('section[data-widget-size]').filter({
    has: page.getByRole('heading', { name: 'Просмотры', exact: true }),
  });
  await expect(hero).toBeVisible();

  await expect.poll(async () => page.locator('[data-widget-tinted]').count()).toBe(1);
  // Тонирована именно история-лид, а не случайная карточка.
  await expect(hero.locator('[data-widget-tinted]')).toHaveCount(1);
});

test('на свежем Обзоре Instagram тонирована ровно одна карточка', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'дефолты доски — desktop-хром');
  await bootDemo(page, '/instagram');

  const hero = page.locator('section[data-widget-size]').filter({
    has: page.getByRole('heading', { name: 'Охват', exact: true }),
  });
  await expect(hero).toBeVisible();

  await expect.poll(async () => page.locator('[data-widget-tinted]').count()).toBe(1);
  await expect(hero.locator('[data-widget-tinted]')).toHaveCount(1);
});
