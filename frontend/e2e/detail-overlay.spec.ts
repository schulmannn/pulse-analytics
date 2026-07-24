import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Разворот карточки (?detail=) — контракт закрытия и компактного сайзинга:
 *  1. Escape закрывает разворот С ПЕРВОГО раза и в диплинк-сценарии (URL открыл оверлей без клика),
 *     чистит ?detail= из URL (replace) и оверлей НЕ возвращается после settle.
 *  2. Обычное открытие кликом: Escape закрывает, фокус возвращается опенеру (шапочный ↗).
 *  3. Не-rich тело (без период/статы-эксплорера) разворачивается в контент-панель по центру вьюпорта.
 * Мобильный полноэкранный шит НЕ здесь — его геометрию держит mobile-nav.spec.ts.
 *
 * Регресс-фикстура оверлея — «Лучшие публикации» (НЕ график: карточки постов). Прежняя фикстура
 * «Состав вовлечённости» мигрировала на выделенный route /metrics/tg-engagement-mix (как и остальные
 * графики Аналитики), поэтому регресс generic-оверлея держит именно эта не-графовая карточка Обзора.
 */

const OVERLAY = 'Лучшие публикации';
const OVERLAY_ID = 'overview-top-posts';
const OVERLAY_URL = `/?detail=${OVERLAY_ID}`;

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
  await bootDemo(page, OVERLAY_URL);
  const dialog = page.getByRole('dialog', { name: `График: ${OVERLAY}` });
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
  await bootDemo(page, '/');
  const heading = page.getByRole('heading', { name: OVERLAY, exact: true });
  await heading.scrollIntoViewIfNeeded();
  // Кликаем именно по неинтерактивному заголовку: центр карточки занят кликабельным постом и
  // закономерно открывает PostDetailModal, а не card-level generic overlay.
  await heading.click();
  const dialog = page.getByRole('dialog', { name: `График: ${OVERLAY}` });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/[?&]detail=/);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]detail=/);
});

test('не-rich тело — контент-панель по центру', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-сайзинг панели');
  await bootDemo(page, OVERLAY_URL);
  await expect(page.getByRole('dialog', { name: `График: ${OVERLAY}` })).toBeVisible();
  const compact = await panelBox(page);
  // Контент-сайзинг: панель НЕ форсится на всю высоту (раньше — full-height с большой пустотой)…
  expect(compact.height).toBeLessThan(compact.vh * 0.9);
  expect(compact.height).toBeGreaterThanOrEqual(180); // …но не схлопывается ниже разумного min.
  // …и по центру вьюпорта.
  const mid = compact.top + compact.height / 2;
  expect(Math.abs(mid - compact.vh / 2)).toBeLessThanOrEqual(24);
});
