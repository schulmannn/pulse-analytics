import { expect, test } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

/**
 * Тайл-состояния данных: ErrorState/EmptyState внутри фикс-высотной (264px) карточки ОБЯЗАНЫ
 * умещаться в слот тела виджета — «Повторить» доступна, ничего не клипается overflow-hidden.
 * Систематический риск из прод-фидбека: min-h-резерв (dataStateSizeClass) + py + многострочный
 * reason превышали слот. Фикс — container queries: слот виджета = size-контейнер `tile`, состояния
 * компактнеют под `tile-short:` (высота слота < 15rem), а не через ручной подбор на каждом call-site.
 *
 * Ошибки принудительные: 500 на MS-роуты Обзора склада (роуты регистрируются ПОСЛЕ bootDemo —
 * Playwright матчит их первыми (LIFO), reload прогоняет запросы через 500-заглушку).
 */
const LONG_REASON =
  'HTTP 500: сервис МойСклад временно недоступен, повторите запрос позже — request id 7f3c9a12';

test('MS overview error tiles fit the 264px slot with the retry reachable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-430', 'Планшет/десктоп: фикс-тайлы; мобильную проекцию держит сосед ниже');
  await bootDemo(page, '/sklad');
  for (const path of ['stock', 'top-products', 'funnel', 'returns']) {
    await page.route(new RegExp(`/api/ms/${path}`), (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: LONG_REASON }) }),
    );
  }
  await page.reload();
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });

  // Ошибочные тайлы дорендерились: у каждого видна «Повторить».
  const retries = page.getByRole('button', { name: 'Повторить' });
  await expect.poll(async () => retries.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(600);

  // Ни один overflow-hidden контейнер не прячет контент (канонический ассерт ms-compact-lists).
  expect(await overflowingCards(page)).toEqual([]);

  // Каждая «Повторить» целиком внутри своей карточки (не просто «не клипнута», а досягаема).
  const misplaced = await page.evaluate(() => {
    const out: Array<{ widget: string; delta: number }> = [];
    for (const button of document.querySelectorAll('button')) {
      if (button.textContent?.trim() !== 'Повторить') continue;
      const card = button.closest('[data-widget-accented], .rounded-2xl') as HTMLElement | null;
      if (!card) continue;
      const cardBox = card.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const delta = Math.max(0, Math.ceil(buttonBox.bottom - cardBox.bottom));
      if (delta > 0) {
        out.push({ widget: card.querySelector('h3')?.textContent?.trim() || '(unnamed)', delta });
      }
    }
    return out;
  });
  expect(misplaced).toEqual([]);
});

test('mobile: MS overview error tiles stay inside their cards', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-430', 'Мобильная проекция того же контракта');
  await bootDemo(page, '/sklad');
  for (const path of ['stock', 'top-products', 'funnel', 'returns']) {
    await page.route(new RegExp(`/api/ms/${path}`), (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: LONG_REASON }) }),
    );
  }
  await page.reload();
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  const retries = page.getByRole('button', { name: 'Повторить' });
  await expect.poll(async () => retries.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(600);
  expect(await overflowingCards(page)).toEqual([]);
});
