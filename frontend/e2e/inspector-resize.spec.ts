import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Ручка инспектора метрик-эксплорера (Astryx Resize Handle): клавиатурный резайз с a11y-контрактом
 * (role=separator + aria-value*), персист через reload, Enter-сброс к дефолту поверхности.
 * Ширина — CSS-переменная :root, сетка ссылается var(--inspector-w, 280px).
 */
test('metric explorer inspector resizes, persists and resets', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-эксплорер');
  await bootDemo(page, '/metrics/views', { theme: 'dark' });

  const handle = page.getByTestId('inspector-handle');
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute('aria-valuenow', '280');

  // ← расширяет панель шагом 16px (ручка у левого края панели).
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '328');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--inspector-w')))
    .toBe('328px');

  // Персист: reload возвращает кастомную ширину (и она же питает IG-эксплорер той же переменной).
  await page.reload();
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await expect(page.getByTestId('inspector-handle')).toHaveAttribute('aria-valuenow', '328');

  // Enter — сброс: переменная снята, поверхность живёт своим дефолтом.
  const fresh = page.getByTestId('inspector-handle');
  await fresh.focus();
  await page.keyboard.press('Enter');
  await expect(fresh).toHaveAttribute('aria-valuenow', '280');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--inspector-w')))
    .toBe('');
});
