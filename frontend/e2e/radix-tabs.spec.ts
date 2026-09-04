import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

test('content route tabs use roving focus, arrows and linked tabpanels', async ({ page }) => {
  await bootDemo(page, '/posts');

  const posts = page.getByRole('tab', { name: 'Публикации' });
  const campaigns = page.getByRole('tab', { name: 'Кампании' });
  const tabList = page.getByRole('tablist', { name: 'Раздел контента' });
  // Один паттерн второго уровня навигации: /posts выглядит ровно как «Разделы аналитики».
  await expect(tabList).toHaveAttribute('data-variant', 'line');
  await expect(tabList.locator('[data-tabs-glider]')).toHaveCount(0);
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
  const tabList = page.getByRole('tablist', { name: 'Разделы аналитики' });
  await expect(tabList).toHaveAttribute('data-variant', 'line');
  await expect(tabList.locator('[data-tabs-glider]')).toHaveCount(0);
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

/**
 * Второй уровень навигации липнет под шапкой страницы (md+): глубоко в «Аудитории» строка табов
 * обязана оставаться и ориентиром, и путём к соседним разделам. Липкость считается от ФАКТИЧЕСКОЙ
 * высоты шапки (--feed-header-h), поэтому проверяем геометрию, а не только видимость.
 */
test('analytics tab row stays pinned under the page header while the section scrolls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-430', 'sticky-строка табов — только md+');
  await bootDemo(page, '/analytics?tab=audience');

  const tabList = page.getByRole('tablist', { name: 'Разделы аналитики' });
  const header = page.locator('[data-feed-page-header]');
  await expect(tabList).toBeVisible();

  const scroller = page.locator('[data-dashboard-scroll]');
  await scroller.evaluate((el) => el.scrollTo({ top: 1200 }));
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);

  await expect(tabList).toBeInViewport();
  const headerBox = await header.boundingBox();
  const listBox = await tabList.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(listBox).not.toBeNull();
  // Прилипшее состояние: строка сидит вплотную под шапкой (в покое зазор — mb-6, т.е. заметно больше).
  const gap = listBox!.y - (headerBox!.y + headerBox!.height);
  expect(gap).toBeGreaterThanOrEqual(-1);
  expect(gap).toBeLessThanOrEqual(20);

  // Переключение таба из прокрученного состояния работает и чистит URL для дефолтного раздела.
  await page.getByRole('tab', { name: 'Динамика' }).click();
  await expect(page.getByRole('tab', { name: 'Динамика' })).toHaveAttribute('aria-selected', 'true');
  await expect(page).not.toHaveURL(/[?&]tab=/);
});
