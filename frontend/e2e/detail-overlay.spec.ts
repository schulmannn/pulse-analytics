import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Разворот карточки (?detail=) — контракт закрытия и компактного сайзинга:
 *  1. Escape закрывает разворот С ПЕРВОГО раза и в диплинк-сценарии (URL открыл оверлей без клика),
 *     чистит ?detail= из URL (replace) и оверлей НЕ возвращается после settle.
 *  2. Обычное открытие кликом: Escape закрывает, фокус возвращается опенеру (шапочный ↗).
 *  3. Мелкое тело без rich-эксплорера (breakdown из 3 строк) разворачивается в компактную панель
 *     по контенту (по центру вьюпорта), а rich-развороты (период/статы) держат полную высоту.
 * Мобильный полноэкранный шит НЕ здесь — его геометрию держит mobile-nav.spec.ts.
 */

const BREAKDOWN = 'Состав вовлечённости';
const BREAKDOWN_URL = `/analytics?tab=content&detail=${encodeURIComponent(BREAKDOWN)}`;

/** Панель диалога = не-backdrop ребёнок ролевого контейнера (backdrop несёт aria-hidden). */
async function panelBox(page: import('@playwright/test').Page) {
  const box = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-label^="График"]');
    if (!d) return null;
    const card = Array.from(d.children).find((el) => el.getAttribute('aria-hidden') !== 'true');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { top: r.top, height: r.height, vh: window.innerHeight };
  });
  if (!box) throw new Error('detail panel not found');
  return box;
}

test('диплинк ?detail=: Escape закрывает с первого раза, чистит URL и не пере-открывается', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-контракт закрытия');
  await bootDemo(page, BREAKDOWN_URL);
  const dialog = page.getByRole('dialog', { name: `График: ${BREAKDOWN}` });
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]detail=/);
  // Guard/эффекты не должны воскресить оверлей после settle.
  await page.waitForTimeout(1200);
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]detail=/);
});

test('клик по карточке открывает детализацию, Escape закрывает', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-контракт закрытия');
  await bootDemo(page, '/analytics?tab=content');
  const card = page.getByRole('heading', { name: BREAKDOWN, exact: true }).locator('xpath=ancestor::section[1]');
  await card.scrollIntoViewIfNeeded();
  await card.click();
  const dialog = page.getByRole('dialog', { name: `График: ${BREAKDOWN}` });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/[?&]detail=/);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]detail=/);
});

test('мелкое тело без rich-эксплорера — компактная панель по центру; rich держит полную высоту', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-сайзинг панели');
  await bootDemo(page, BREAKDOWN_URL);
  await expect(page.getByRole('dialog', { name: `График: ${BREAKDOWN}` })).toBeVisible();
  const compact = await panelBox(page);
  // Контент-сайзинг: заметно меньше вьюпорта (раньше — full-height с ~80% пустоты)…
  expect(compact.height).toBeLessThan(compact.vh * 0.6);
  expect(compact.height).toBeGreaterThanOrEqual(180); // …но не схлопывается ниже разумного min.
  // …и по центру вьюпорта.
  const mid = compact.top + compact.height / 2;
  expect(Math.abs(mid - compact.vh / 2)).toBeLessThanOrEqual(12);

  // Rich-разворот (период-пилюли/статы: «Упоминания по дням») остаётся полноэкранной панелью.
  await bootDemo(page, '/mentions?detail=mentions-timeline');
  await expect(page.getByRole('dialog', { name: 'График: Упоминания по дням' })).toBeVisible();
  const rich = await panelBox(page);
  expect(rich.height).toBeGreaterThan(rich.vh * 0.9);
});
