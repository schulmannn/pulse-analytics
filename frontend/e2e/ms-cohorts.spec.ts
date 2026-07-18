import { expect, test } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
});

test('cohort mode toggles retention / revenue / LTV, persisting in the URL across reload', async ({ page }) => {
  await bootDemo(page, '/metrics/ms-cohorts', { theme: 'dark' });

  const mode = page.getByRole('group', { name: 'Режим когортной матрицы' });
  const matrix = page.getByRole('table');

  // Default: retention, no `mode` in the URL, cells rendered as percentages.
  await expect(mode.getByRole('button', { name: 'Возвращаемость' })).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).searchParams.has('mode')).toBe(false);
  await expect(page.getByText(
    'Доля клиентов когорты, сделавших заказ через N месяцев после первой покупки; «0» — месяц самой первой покупки.',
    { exact: true },
  )).toBeVisible();
  await expect(matrix.locator('td span', { hasText: '%' }).first()).toBeVisible();

  // Revenue per customer: URL carries mode=revenue and cells show rubles.
  await mode.getByRole('button', { name: 'Выручка/клиент' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('revenue');
  await expect(page.getByText(
    'Выручка заказов N-го месяца на одного ИСХОДНОГО клиента когорты (₽), помесячно — не среднее и не прибыль; возвраты не вычтены.',
    { exact: true },
  )).toBeVisible();
  await expect(matrix.locator('td span', { hasText: '₽' }).first()).toBeVisible();
  const oldestCohort = matrix.getByRole('row').nth(1);
  await expect(oldestCohort.getByText('5k ₽', { exact: true })).toBeVisible();
  await expect(oldestCohort.getByText('3.3k ₽', { exact: true })).toBeVisible();

  // Reload keeps the selected mode (URL is the source of truth).
  await page.reload();
  await expect(mode.getByRole('button', { name: 'Выручка/клиент' })).toHaveAttribute('aria-pressed', 'true');
  await expect(matrix.locator('td span', { hasText: '₽' }).first()).toBeVisible();

  // LTV: cumulative revenue, distinct mode value and caption.
  await mode.getByRole('button', { name: 'LTV' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('ltv');
  await expect(page.getByText(
    'Накопленная выручка с 0-го по N-й месяц на одного ИСХОДНОГО клиента когорты (₽) — LTV; возвраты не вычтены.',
    { exact: true },
  )).toBeVisible();
  await expect(oldestCohort.getByText('8.3k ₽', { exact: true })).toBeVisible();

  // Back to retention drops the param entirely (default omitted from the canonical URL).
  await mode.getByRole('button', { name: 'Возвращаемость' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has('mode')).toBe(false);
  expect(await overflowingCards(page)).toEqual([]);
});
