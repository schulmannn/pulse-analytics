import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Sonner-тосты: первые честные call-sites — действия, результат которых живёт НЕ на текущем
 * экране. Флагман: «На главную» из ⋯-меню виджета на странице фида (карточка появляется на
 * /home; до тостов действие было полностью немым).
 */
test('pin to Home from a feed page raises a toast with an open action', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop: ⋯-меню и pin-путь');
  await bootDemo(page, '/');

  // Открываем ⋯-меню первого виджета с пунктом «На главную» и жмём его.
  const menuButtons = page.getByRole('button', { name: /^Меню виджета/ });
  await menuButtons.first().waitFor({ timeout: 15_000 });
  const count = await menuButtons.count();
  let pinned = false;
  for (let index = 0; index < count && !pinned; index++) {
    await menuButtons.nth(index).click();
    const pin = page.getByRole('menuitem', { name: 'На главную' });
    if (await pin.count()) {
      await pin.click();
      pinned = true;
    } else {
      await page.keyboard.press('Escape');
    }
  }
  expect(pinned, 'ни у одного виджета нет пункта «На главную»').toBe(true);

  // Тост с заголовком-меткой виджета и действием «Открыть» → /home.
  const toast = page.locator('[data-sonner-toast]').first();
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText('на главной');
  await toast.getByRole('button', { name: 'Открыть' }).click();
  await expect(page).toHaveURL(/\/home$/);
});
