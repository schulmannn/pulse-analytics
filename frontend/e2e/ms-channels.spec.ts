import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
  await bootDemo(page, '/sklad/channels', { theme: 'dark' });
});

test('MoySklad channels uses the flat feed shell and multi-channel explorer', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await expect(page.getByRole('heading', { name: 'Каналы', exact: true })).toBeVisible();
  await expect(page.locator('[data-source-identity]')).toContainText('МойСклад');
  await expect(page.getByRole('heading', { name: 'Atlavue', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Период', exact: true })).toHaveCount(1);

  // Anchor on the stable control group: the widget heading changes with the selected metric.
  const dynamics = page.locator('section').filter({ has: page.getByRole('group', { name: 'Метрика', exact: true }) }).first();
  await expect(dynamics.getByRole('group', { name: 'Метрика', exact: true })).toBeVisible();
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
  await expect(comparisonChart.locator('svg')).toHaveAttribute('data-chart-curve', 'smooth');
  await expect(comparisonChart.locator('path').first()).toHaveAttribute('d', /\bC/);
  const channelMotion = comparisonChart.locator('[data-chart-motion="reveal"]');
  await expect(channelMotion).toHaveCount(1);
  const channelAnimation = await channelMotion.evaluate((element) => getComputedStyle(element).animationName);
  expect(channelAnimation).toContain('chart-fade-in');
  await comparisonChart.focus();
  await expect(dynamics.locator('.z-tooltip')).toBeVisible();
  await page.keyboard.press('ArrowLeft');

  const pageShot = testInfo.outputPath('moysklad-channels-page-dark.png');
  await page.screenshot({ path: pageShot, fullPage: true });
  await testInfo.attach('moysklad-channels-page-dark', { path: pageShot, contentType: 'image/png' });

  // Sparse AOV keeps the shared calendar axis and honest empty tooltips, but each selected channel
  // remains a readable observation line instead of a collection of isolated one-point segments.
  await dynamics.getByRole('group', { name: 'Метрика', exact: true }).getByRole('button', { name: 'Средний чек' }).click();
  const aovComparisonChart = dynamics.getByRole('img', { name: /Средний чек по каналам/ });
  await expect(aovComparisonChart).toBeVisible();
  await expect(dynamics.getByText(/только периоды с заказами/)).toBeVisible();
  const aovShot = testInfo.outputPath('moysklad-channels-aov-dark.png');
  await page.screenshot({ path: aovShot, fullPage: true });
  await testInfo.attach('moysklad-channels-aov-dark', { path: aovShot, contentType: 'image/png' });
  await dynamics.getByRole('group', { name: 'Метрика', exact: true }).getByRole('button', { name: 'Выручка' }).click();

  // «Развернуть» ведёт на полностраничную метрику /metrics/ms-channels (общий explorer с MS-контролами),
  // а не в модальный оверлей. Страница открывается со своим состоянием (агрегат по умолчанию).
  await page.getByRole('button', { name: /Развернуть виджет «Выручка по каналам/ }).click();
  await expect(page).toHaveURL(/\/metrics\/ms-channels$/);
  // The MS metric page is a lazy chunk. Allow the cold Vite transform to finish when this suite
  // runs in parallel with the all-routes parity pass; the production bundle is already built.
  await expect(page.getByRole('heading', { name: 'Каналы продаж', level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Метрика' })).toBeVisible();
  const viewGroup = page.getByRole('group', { name: 'Вид' });
  await expect(viewGroup).toBeVisible();
  const windowGroup = page.getByRole('group', { name: 'Окно', exact: true });
  await expect(windowGroup).toBeVisible();
  await expect(windowGroup.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: 'Грануляция' })).toBeVisible();
  // Aggregate (default) owns the meaningful line/bar toggle; breakdown stays a multi-line comparison.
  await expect(page.getByRole('group', { name: 'Тип графика' })).toBeVisible();
  await viewGroup.getByRole('button', { name: 'По каналам' }).click();
  await expect(page.getByRole('group', { name: 'Тип графика' })).toHaveCount(0);
  await viewGroup.getByRole('button', { name: 'Итог' }).click();
  await expect(page.getByRole('group', { name: 'Тип графика' })).toBeVisible();
  await page.getByRole('group', { name: 'Тип графика' }).getByRole('button', { name: 'Столбцы' }).click();

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

test('MoySklad channel contribution compares an equal window in the canonical metric page', async ({ page }) => {
  const contribution = page.getByRole('heading', { name: 'Что изменило результат', exact: true })
    .locator('xpath=ancestor::section[1]');
  const metric = contribution.getByRole('group', { name: 'Метрика вклада каналов' });
  await expect(metric.getByRole('button', { name: 'Выручка' })).toHaveAttribute('aria-pressed', 'true');
  await expect(contribution.getByText('Без канала', { exact: true })).toBeVisible();
  await expect(contribution.getByText(/в сумме дают общее изменение/)).toBeVisible();
  await metric.getByRole('button', { name: 'Заказы' }).click();
  await expect(metric.getByRole('button', { name: 'Заказы' })).toHaveAttribute('aria-pressed', 'true');

  await contribution.getByRole('button', { name: 'Развернуть виджет «Что изменило результат»' }).click();
  await expect(page).toHaveURL(/\/metrics\/ms-sales-channels$/);
  await expect(page.getByRole('heading', { name: 'Продажи по каналам', level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Что изменило результат', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Структура текущего периода', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Метрика вклада каналов' })).toBeVisible();
  await expect(page.getByText(/положительные и отрицательные изменения каналов/i)).toBeVisible();
});
