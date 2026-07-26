import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

test('content route tabs use roving focus, arrows and linked tabpanels', async ({ page }) => {
  await bootDemo(page, '/posts');

  const posts = page.getByRole('tab', { name: 'Публикации' });
  const campaigns = page.getByRole('tab', { name: 'Кампании' });
  await posts.focus();
  await page.keyboard.press('ArrowRight');

  await expect(campaigns).toBeFocused();
  await expect(campaigns).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/[?&]view=campaigns/);
  const panelId = await campaigns.getAttribute('aria-controls');
  expect(panelId).toBeTruthy();
  await expect(page.locator(`[id="${panelId}"]`)).toHaveAttribute('role', 'tabpanel');

  await page.keyboard.press('ArrowLeft');
  await expect(posts).toBeFocused();
  await expect(posts).toHaveAttribute('aria-selected', 'true');
  await expect(page).not.toHaveURL(/[?&]view=/);
});

test('analytics tabs delegate Home/End and panel relationships to Radix', async ({ page }) => {
  await bootDemo(page, '/analytics?tab=audience');

  const audience = page.getByRole('tab', { name: 'Аудитория' });
  await audience.focus();
  await page.keyboard.press('End');
  const compare = page.getByRole('tab', { name: 'Сравнение' });
  await expect(compare).toBeFocused();
  await expect(compare).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/[?&]tab=compare/);

  await page.keyboard.press('Home');
  const dynamics = page.getByRole('tab', { name: 'Динамика' });
  await expect(dynamics).toBeFocused();
  await expect(dynamics).toHaveAttribute('aria-selected', 'true');
  await expect(page).not.toHaveURL(/[?&]tab=/);
});
