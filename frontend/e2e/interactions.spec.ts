import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

test('detail open + back (metric drilldown)', async ({ page }) => {
  await bootDemo(page, '/');
  // A drillable KPI hero exposes an aria-label «Разбор: …»; clicking it opens the metric detail page.
  const drill = page.getByRole('button', { name: /^Разбор:/ }).first();
  await drill.waitFor({ state: 'visible', timeout: 15_000 });
  await drill.click();
  await expect(page).toHaveURL(/\/metrics\//);
  // the detail page renders its own content (a card / heading)
  await page.locator('section h3, h1, h2').first().waitFor({ timeout: 10_000 });
  await page.goBack();
  await expect(page).not.toHaveURL(/\/metrics\//);
});

test('edit-mode entry + exit (Home)', async ({ page }) => {
  await bootDemo(page, '/home');
  // The «Изменить»↔«Готово» toggle reflects edit state via aria-pressed — robust whether Home is
  // empty or has pinned widgets (the empty state carries its own «Добавить виджет» button, so that
  // label alone can't distinguish the modes).
  const toggle = page.locator('button.edit-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true'); // entered edit mode
  await expect(page.getByRole('button', { name: /Добавить виджет/ })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false'); // exited
});
