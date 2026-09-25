import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Windows High Contrast (`forced-colors: active`) — гейт, а не косметика.
 *
 * Опасение было такое: серии красятся inline-атрибутами `fill/stroke="hsl(var(--chart-role-*))"`,
 * а в контрастном режиме браузер форсит цвета — значит все серии схлопнутся в один системный цвет
 * и график станет нечитаем. ЗАМЕР ЭТО ОПРОВЕРГ: Chromium НЕ форсит SVG-презентационные атрибуты,
 * поэтому линии сохраняют свои цвета, а оболочка (фон, рамки, текст) честно переходит на
 * системные. Это ровно то поведение, которое нужно data-viz.
 *
 * Спека фиксирует достигнутое: если кто-то переведёт заливку серий с атрибутов на CSS-класс или
 * добавит `forced-color-adjust`, цвета начнёт форсить — и тест это поймает раньше пользователя.
 */
test('charts stay readable and keep distinct series colours in forced-colors mode', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'десктопная поверхность графиков');
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' });
  await bootDemo(page, '/', { theme: 'dark' });
  await page.waitForTimeout(2500);

  const series = page.locator('svg [data-chart-series="current"], svg path[stroke*="chart-role"]');
  await expect(series.first()).toBeVisible();

  // Ключевое: цвет серии — РАЗРЕШЁННЫЙ цвет, а не системный. Если браузер начнёт форсить, здесь
  // окажется одинаковый системный цвет у всех серий, и набор схлопнется в один элемент.
  const strokes = await page.evaluate(() =>
    [...document.querySelectorAll('svg path[stroke], svg rect[fill]')]
      .map((el) => getComputedStyle(el).stroke || getComputedStyle(el).fill)
      .filter((c) => c && c !== 'none'),
  );
  expect(strokes.length, 'серии должны присутствовать').toBeGreaterThan(0);
  expect(new Set(strokes).size, 'серии не должны схлопнуться в один цвет').toBeGreaterThan(1);
});
