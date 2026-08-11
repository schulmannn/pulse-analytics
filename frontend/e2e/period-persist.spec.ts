import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Окно ленты переживает смену источника. До общего store у КАЖДОЙ сети был свой
 * PagePeriodProvider с локальным стейтом, поэтому переход TG → IG монтировал новый экземпляр и
 * выбор терялся (владелец: «выбрал кастомный таймфрейм, перешёл на другой источник — сбросился»).
 */
test('выбранное окно переживает переход между сетями', async ({ page }) => {
  await bootDemo(page, '/');
  const tgPeriod = page.getByRole('group', { name: 'Период', exact: true });
  await expect(tgPeriod.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');

  await tgPeriod.getByRole('button', { name: '90д' }).click();
  await expect(tgPeriod.getByRole('button', { name: '90д' })).toHaveAttribute('aria-pressed', 'true');

  // Instagram — ДРУГАЯ сеть, то есть другой экземпляр провайдера. Раньше здесь возвращалось 30д.
  await page.goto('/instagram');
  await page.locator('main').waitFor({ state: 'visible' });
  const igPeriod = page.getByRole('group', { name: 'Период', exact: true }).first();
  await expect(igPeriod.getByRole('button', { name: '90д' })).toHaveAttribute('aria-pressed', 'true');

  // …и обратно: выбор не «прилип» к одной сети, он общий.
  await page.goto('/');
  await page.locator('main').waitFor({ state: 'visible' });
  await expect(
    page.getByRole('group', { name: 'Период', exact: true }).getByRole('button', { name: '90д' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('окно переживает перезагрузку страницы', async ({ page }) => {
  await bootDemo(page, '/');
  const period = page.getByRole('group', { name: 'Период', exact: true });
  await period.getByRole('button', { name: '7д' }).click();
  await expect(period.getByRole('button', { name: '7д' })).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await page.locator('main').waitFor({ state: 'visible' });
  await expect(
    page.getByRole('group', { name: 'Период', exact: true }).getByRole('button', { name: '7д' }),
  ).toHaveAttribute('aria-pressed', 'true');
});
