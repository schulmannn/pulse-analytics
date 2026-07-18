import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
  await bootDemo(page, '/sklad', { theme: 'dark' });
});

test('MoySklad revenue drills into the full /metrics/ms-revenue page with working controls', async ({ page }, testInfo) => {
  // «Развернуть» на карточке «Выручка» больше не открывает модалку `?detail=`, а ведёт на
  // полностраничную метрику `/metrics/ms-revenue` — та же архитектура, что у эталона IG /metrics/ig-reach.
  await page.getByRole('button', { name: 'Развернуть виджет «Выручка»' }).click();
  await expect(page).toHaveURL(/\/metrics\/ms-revenue$/);

  // Тихая шапка + назад-ссылка на раздел (никакой role="dialog").
  await expect(page.getByRole('heading', { name: 'Выручка', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /МойСклад · Обзор/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Сравнение' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'База сравнения' })).toBeVisible();

  // Контролы графика живут на самой странице: окно, грануляция, тип графика.
  const windowGroup = page.getByRole('group', { name: 'Окно', exact: true });
  const grainGroup = page.getByRole('group', { name: 'Грануляция' });
  const kindGroup = page.getByRole('group', { name: 'Тип графика' });
  await expect(windowGroup).toBeVisible();
  await expect(windowGroup.getByRole('button', { name: 'Свой период' })).toBeVisible();
  await expect(grainGroup).toBeVisible();
  await expect(kindGroup).toBeVisible();

  await expect(windowGroup.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('за 30 дн.')).toBeVisible();
  await expect(page.locator('svg[data-chart-kind="line"]')).toBeVisible();

  // Окно тянет ВЫБРАННЫЙ период (архитектурная проверка через точный запрос), а не топбар-payload.
  const request90 = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/ms/summary' && url.searchParams.get('days') === '90';
  });
  await windowGroup.getByRole('button', { name: '90д' }).click();
  const request = await request90;
  const requestUrl = new URL(request.url());
  const from = requestUrl.searchParams.get('from');
  const to = requestUrl.searchParams.get('to');
  expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // Пресет закреплён на локальных календарных днях браузера: обе границы реально уходят в API,
  // окно включительно содержит ровно 90 дней, а правая граница — локальное «сегодня».
  const utcDay = (key: string) => {
    const [year, month, day] = key.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  expect((utcDay(to!) - utcDay(from!)) / 86_400_000 + 1).toBe(90);
  const localToday = await page.evaluate(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
  expect(to).toBe(localToday);
  await expect(windowGroup.getByRole('button', { name: '90д' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('за 90 дн.')).toBeVisible();

  // Грануляция (день → месяц).
  await grainGroup.getByRole('button', { name: 'Месяц' }).click();
  await expect(grainGroup.getByRole('button', { name: 'Месяц' })).toHaveAttribute('aria-pressed', 'true');

  // Линия ↔ столбцы.
  await kindGroup.getByRole('button', { name: 'Столбцы' }).click();
  await expect(page.locator('svg[data-chart-kind="bar"]')).toBeVisible();

  const shot = testInfo.outputPath('moysklad-revenue-explorer-dark.png');
  await page.screenshot({ path: shot, fullPage: true });
  await testInfo.attach('moysklad-revenue-explorer-dark', { path: shot, contentType: 'image/png' });
});

test('legacy detail deep-link redirects to the canonical MS metric route', async ({ page }) => {
  await bootDemo(page, '/sklad?detail=ms-revenue', { theme: 'dark' });
  await expect(page).toHaveURL(/\/metrics\/ms-revenue$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
