import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
  await bootDemo(page, '/sklad/channels', { theme: 'dark' });
});

test('MoySklad channels uses the flat feed shell and multi-channel explorer', async ({ page }, testInfo) => {
  await expect(page.getByRole('heading', { name: 'Каналы', exact: true })).toBeVisible();
  await expect(page.locator('[data-source-identity]')).toContainText('МойСклад');
  await expect(page.getByRole('heading', { name: 'Atlavue', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Период', exact: true })).toHaveCount(1);

  // Anchor on the stable control group: the widget heading changes with the selected metric.
  const dynamics = page.locator('section').filter({ has: page.getByRole('group', { name: 'Метрика' }) }).first();
  await expect(dynamics.getByRole('group', { name: 'Метрика' })).toBeVisible();
  await expect(dynamics.getByRole('group', { name: 'Вид' })).toBeVisible();

  await dynamics.getByRole('button', { name: 'Все каналы' }).click();
  const picker = dynamics.getByRole('group', { name: 'Каналы продаж' });
  await picker.getByRole('checkbox', { name: 'Интернет-магазин' }).check();
  await picker.getByRole('checkbox', { name: 'Партнёры' }).check();
  await page.keyboard.press('Escape');
  await expect(dynamics.getByRole('button', { name: 'Каналы: 2' })).toBeVisible();
  await expect(dynamics.getByText('2 канала', { exact: true })).toBeVisible();

  await dynamics.getByRole('group', { name: 'Вид' }).getByRole('button', { name: 'По каналам' }).click();
  const comparisonChart = dynamics.getByRole('img', {
    name: /Выручка по каналам: Интернет-магазин, Партнёры/,
  });
  await expect(comparisonChart).toBeVisible();
  await comparisonChart.focus();
  await expect(dynamics.locator('.z-tooltip')).toBeVisible();
  await page.keyboard.press('ArrowLeft');

  const pageShot = testInfo.outputPath('moysklad-channels-page-dark.png');
  await page.screenshot({ path: pageShot, fullPage: true });
  await testInfo.attach('moysklad-channels-page-dark', { path: pageShot, contentType: 'image/png' });

  // Sparse AOV keeps the shared calendar axis and honest empty tooltips, but each selected channel
  // remains a readable observation line instead of a collection of isolated one-point segments.
  await dynamics.getByRole('group', { name: 'Метрика' }).getByRole('button', { name: 'Средний чек' }).click();
  const aovComparisonChart = dynamics.getByRole('img', { name: /Средний чек по каналам/ });
  await expect(aovComparisonChart).toBeVisible();
  await expect(dynamics.getByText(/только периоды с заказами/)).toBeVisible();
  const aovShot = testInfo.outputPath('moysklad-channels-aov-dark.png');
  await page.screenshot({ path: aovShot, fullPage: true });
  await testInfo.attach('moysklad-channels-aov-dark', { path: aovShot, contentType: 'image/png' });
  await dynamics.getByRole('group', { name: 'Метрика' }).getByRole('button', { name: 'Выручка' }).click();

  await page.getByRole('button', { name: /Развернуть виджет «Выручка по каналам/ }).click();
  const dialog = page.getByRole('dialog', { name: /График: Выручка по каналам/ });
  await expect(dialog.getByRole('group', { name: 'Метрика' })).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'Вид' })).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'Окно' })).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'Окно' }).getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('group', { name: 'Грануляция' })).toBeVisible();
  // Breakdown stays a multi-line comparison; aggregate mode owns the meaningful line/bar toggle.
  await expect(dialog.getByRole('group', { name: 'Тип графика' })).toHaveCount(0);
  await dialog.getByRole('group', { name: 'Вид' }).getByRole('button', { name: 'Итог' }).click();
  await expect(dialog.getByRole('group', { name: 'Тип графика' })).toBeVisible();
  await dialog.getByRole('group', { name: 'Тип графика' }).getByRole('button', { name: 'Тип графика: Столбцы' }).click();

  const shot = testInfo.outputPath('moysklad-channels-explorer-dark.png');
  await page.screenshot({ path: shot, fullPage: true });
  await testInfo.attach('moysklad-channels-explorer-dark', { path: shot, contentType: 'image/png' });
});

test('MoySklad channel ranking exposes useful sorting and derived metrics', async ({ page }) => {
  const ranking = page.getByRole('heading', { name: /Продажи по каналам/ }).locator('xpath=ancestor::section[1]');
  await expect(ranking.getByText(/ср\./).first()).toBeVisible();
  await expect(ranking.getByText(/%/).first()).toBeVisible();

  const sort = ranking.getByRole('group', { name: 'Сортировка каналов' });
  await sort.getByRole('button', { name: 'Имя' }).click();
  const labels = await ranking.locator('div.flex.items-baseline.justify-between span.truncate').allTextContents();
  expect(labels.slice(0, 3)).toEqual(['Интернет-магазин', 'Партнёры', 'Розница']);
});
