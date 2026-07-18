import { expect, test } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
  await bootDemo(page, '/sklad', { theme: 'dark' });
});

test('MoySklad returns compact card shows a real series and drills to a full count/sum page', async ({ page }) => {
  const card = page.getByRole('heading', { name: 'Возвраты', exact: true }).locator('xpath=ancestor::section[1]');
  // Реальный график (не декоративный) + честные число/сумма и явная сноска «отдельно от выручки».
  const charts = card.getByRole('img');
  await expect(charts).toHaveCount(1);
  await expect(charts).toBeVisible();
  await expect(card.getByText(/₽/).first()).toBeVisible();
  await expect(card.getByText('Возвраты считаются отдельно и из выручки не вычитаются.')).toBeVisible();

  await card.getByRole('button', { name: 'Развернуть виджет «Возвраты»' }).click();

  await expect(page).toHaveURL(/\/metrics\/ms-returns$/);
  await expect(page.getByRole('heading', { name: 'Возвраты', level: 1 })).toBeVisible({ timeout: 20_000 });

  // Segmented count/sum control: «Число» по умолчанию, сравнение подписано соответствующе.
  const metric = page.getByRole('group', { name: 'Метрика возвратов' });
  await expect(metric.getByRole('button', { name: 'Число' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Число возвратов', { exact: true })).toBeVisible();

  await metric.getByRole('button', { name: 'Сумма' }).click();
  await expect(metric.getByRole('button', { name: 'Сумма' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Сумма возвратов', { exact: true })).toBeVisible();

  // Общая грамматика полной метрик-страницы + honest separate-from-revenue note.
  await expect(page.getByRole('heading', { name: 'Сравнение' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'О метрике' })).toBeVisible();
  await expect(page.getByText('Возвраты считаются отдельно и из выручки не вычитаются.').first()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await overflowingCards(page)).toEqual([]);
});
