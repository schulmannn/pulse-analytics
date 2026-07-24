import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Telegram «дополнительные» графики — полноэкранные /metrics/tg-*. Проверяем миграцию карточек
 * Аналитики (тепловая карта активности, скорость набора просмотров) с generic `?detail=` оверлея на
 * выделенные route-страницы (грамматика эталона /metrics/ig-views / /metrics/ym-visits): клик по
 * карточке ведёт на route (не role=dialog), прямой заход + reload держат TG-контекст, у скорости
 * есть Line/Bar (обе честны для накопительной кривой), у тепловой карты — своя heatmap-форма без
 * выдуманного Line/Bar/сравнения.
 *
 * Boot из client-side demo-фикстур (pulse_demo) — реальных Telegram-кредов в раннере нет.
 */

test.describe('Telegram extra-chart metric pages', () => {
  test('клик по «Тепловая карта активности» ведёт на /metrics/tg-heatmap (route, не модалка)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/analytics?tab=audience');

    await page.getByRole('heading', { name: 'Тепловая карта активности', exact: true }).click();

    await expect(page).toHaveURL(/\/metrics\/tg-heatmap$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Тепловая карта активности', level: 1 })).toBeVisible();

    // Назад-ссылка возвращает в Аналитику · Аудитория.
    await page.getByRole('link', { name: /Аналитика · Аудитория/ }).click();
    await expect(page).toHaveURL(/\/analytics/);
  });

  test('клик по «Скорость набора просмотров» ведёт на /metrics/tg-velocity (route, не модалка)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/analytics?tab=dynamics');

    await page.getByRole('heading', { name: 'Скорость набора просмотров', exact: true }).click();

    await expect(page).toHaveURL(/\/metrics\/tg-velocity$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Скорость набора просмотров', level: 1 })).toBeVisible();
  });

  test('прямой заход /metrics/tg-heatmap + reload держит TG-контекст, без Line/Bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/metrics/tg-heatmap');

    await expect(page.getByRole('heading', { name: 'Тепловая карта активности', level: 1 })).toBeVisible();
    await expect(page.locator('[data-source-identity]')).toContainText('Telegram');
    // Heatmap — своя форма: никакого выдуманного селектора типа графика и никакого сравнения.
    await expect(page.getByRole('group', { name: 'Тип графика' })).toHaveCount(0);
    // Окно окна есть (heatmap пересобирается по окну).
    await expect(page.getByRole('group', { name: 'Окно' })).toBeVisible();

    await page.reload();
    await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
    await expect(page.getByRole('heading', { name: 'Тепловая карта активности', level: 1 })).toBeVisible();
    await expect(page.locator('[data-source-identity]')).toContainText('Telegram');
  });

  test('прямой заход /metrics/tg-velocity + reload держит TG-контекст, есть Line/Bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/metrics/tg-velocity');

    await expect(page.getByRole('heading', { name: 'Скорость набора просмотров', level: 1 })).toBeVisible();
    await expect(page.locator('[data-source-identity]')).toContainText('Telegram');
    // Накопительная кривая честна и линией, и столбцами → селектор типа графика есть.
    await expect(page.getByRole('group', { name: 'Тип графика' })).toBeVisible();
    // Bar-режим переключается без падения.
    await page.getByRole('group', { name: 'Тип графика' }).getByText('Столбцы').click();

    await page.reload();
    await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
    await expect(page.getByRole('heading', { name: 'Скорость набора просмотров', level: 1 })).toBeVisible();
  });

  test('stale ?detail=<migrated-id> канонизируется в /metrics/tg-heatmap без dialog', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    // Устаревший deep-link на generic оверлей мигрированной карточки должен увести на выделенный route.
    await bootDemo(page, '/analytics?tab=audience&detail=Тепловая карта активности');

    await expect(page).toHaveURL(/\/metrics\/tg-heatmap$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Тепловая карта активности', level: 1 })).toBeVisible();
  });
});
