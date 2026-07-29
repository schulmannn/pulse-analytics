import { expect, test } from '@playwright/test';
import { bootDemo, expandFirstWidget } from './helpers';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop segmented controls');
  await bootDemo(page, '/home', { theme: 'dark' });
});

test('full-screen widget editor uses labelled shadcn toggle groups for chart settings', async ({ page }) => {
  const buildDefaults = page.getByRole('button', { name: 'Собрать по умолчанию' });
  if (await buildDefaults.isVisible()) await buildDefaults.click();
  await expandFirstWidget(page);

  // Разворот виджета Главной — полностраничный маршрут /widgets/:id, а не модалка: сегменты живут
  // на самой странице. Ленивый чанк страницы ждём явно (тот же приём, что у MS-метрик).
  await expect(page).toHaveURL(/\/widgets\//);
  const editor = page.locator('main');
  await expect(editor.getByRole('toolbar', { name: 'Период', exact: true })).toBeVisible({ timeout: 20_000 });

  const period = editor.getByRole('toolbar', { name: 'Период', exact: true });
  await expect(period).toBeVisible();
  await expect(period).toHaveAttribute('data-slot', 'toggle-group');
  await expect(period.locator('[data-slot="toggle-group-item"]')).toHaveCount(4);
  await period.getByRole('button', { name: '7д', exact: true }).click();
  await expect(period.getByRole('button', { name: '7д', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(period.getByRole('button', { name: '30д', exact: true })).toHaveAttribute('aria-pressed', 'false');

  const viz = editor.getByRole('toolbar', { name: 'Визуализация', exact: true });
  await expect(viz).toBeVisible();
  await viz.getByRole('button', { name: 'Столбцы', exact: true }).click();
  await expect(viz.getByRole('button', { name: 'Столбцы', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await expect(editor.getByRole('toolbar', { name: 'Грануляция', exact: true })).toBeVisible();
  await expect(editor.getByRole('toolbar', { name: 'Сравнение', exact: true })).toBeVisible();

  // Возврат на доску: у полностраничного разворота это обычный Back, а не кнопка «Закрыть» модалки.
  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.locator('h3.widget-title').first()).toBeVisible();
});

test('segmented controls have a real roving focus without changing selection on arrows', async ({ page }) => {
  const buildDefaults = page.getByRole('button', { name: 'Собрать по умолчанию' });
  if (await buildDefaults.isVisible()) await buildDefaults.click();
  await expandFirstWidget(page);

  const editor = page.locator('main');
  const period = editor.getByRole('toolbar', { name: 'Период', exact: true });
  await expect(period).toBeVisible({ timeout: 20_000 });
  const segments = period.getByRole('button');
  expect(await segments.count()).toBeGreaterThanOrEqual(3);

  // Start from the first selected answer. Arrow keys move focus only, and repeated presses must use
  // the live caret rather than snapping back to the still-selected segment.
  await segments.nth(0).click();
  await expect(segments.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await segments.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(segments.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(segments.nth(2)).toBeFocused();
  await expect(segments.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(segments.nth(2)).toHaveAttribute('aria-pressed', 'false');

  // End/ArrowRight and Home/ArrowLeft prove both direct jumps and wrapping.
  await page.keyboard.press('End');
  await expect(segments.last()).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(segments.first()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(segments.first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(segments.last()).toBeFocused();

  // A controlled value update that does not focus its target (DOM click()) changes the pressed
  // answer while Radix deliberately keeps the roving tab stop on the last keyboard-focused item.
  await segments.nth(1).evaluate((button: HTMLButtonElement) => button.click());
  await expect(segments.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(segments.nth(1)).toHaveAttribute('tabindex', '-1');
  await expect(segments.last()).toHaveAttribute('tabindex', '0');
});
