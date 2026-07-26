import { test, expect, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Перестановка виджетов клавиатурой. WidgetGroup.move() существовал давно, но потребителя не имел:
 * reorder-режим был чисто указательным, а живых объявлений не было вовсе. Теперь у карточки в
 * reorder-режиме есть фокусируемая ручка, стрелки ← → двигают её, новая позиция объявляется в
 * aria-live, фокус остаётся на ручке.
 */
const seedBoard = (page: Page) =>
  page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['kpi', 'ig-reach'] }));
  });

/** Подписи карточек доски в ВИЗУАЛЬНОМ порядке (его задаёт CSS order, DOM не переставляется). */
const boardOrder = (page: Page) =>
  page.$$eval('section:has([data-reorder-handle])', (sections) =>
    sections
      .map((section) => ({
        label: section.querySelector('h3')?.textContent?.trim() ?? '',
        order: Number(getComputedStyle(section).order || '0'),
      }))
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.label),
  );

test.describe('reorder виджетов с клавиатуры (/home, 1440)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'десктопная доска Главной');
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedBoard(page);
    await bootDemo(page, '/home', { theme: 'dark' });
    // Reorder-режим включается из меню любой карточки — как и указательный сценарий.
    await page.locator('button[aria-label^="Меню виджета"]').first().click();
    await page.getByRole('menuitem', { name: 'Переставить' }).click();
    await expect(page.locator('[data-reorder-done]')).toBeVisible();
  });

  test('стрелки двигают карточку, порядок сохраняется, фокус остаётся на ручке', async ({ page }) => {
    const handle = page.locator('[data-reorder-handle]').first();
    await expect(handle).toBeVisible();
    const label = ((await handle.getAttribute('aria-label')) ?? '').replace(
      /^Переместить виджет «(.*)»$/,
      '$1',
    );
    expect(label.length).toBeGreaterThan(0);

    const before = await boardOrder(page);
    expect(before.length).toBeGreaterThan(1);
    expect(before[0]).toBe(label);

    await handle.focus();
    await expect(handle).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect.poll(() => boardOrder(page)).not.toEqual(before);
    const after = await boardOrder(page);
    expect(after.indexOf(label)).toBe(1);
    expect(after[0]).toBe(before[1]);
    // Фокус пережил перестановку — иначе следующая стрелка уехала бы в пустоту.
    await expect(handle).toBeFocused();
    // Новая позиция объявлена ассистивным технологиям.
    await expect(page.locator('[data-reorder-status]')).toHaveText(
      new RegExp(`«${label}» — позиция 2 из \\d+`),
    );

    // Порядок персистится (тот же store, что и у drag-перестановки).
    const stored = await page.evaluate(() => localStorage.getItem('pulse_widget_order'));
    expect(stored).toBeTruthy();

    // Обратно — доска возвращается ровно к исходному порядку.
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => boardOrder(page)).toEqual(before);
    await expect(handle).toBeFocused();
  });

  test('край списка объявляется, а не проглатывается молча', async ({ page }) => {
    const handle = page.locator('[data-reorder-handle]').first();
    const label = ((await handle.getAttribute('aria-label')) ?? '').replace(
      /^Переместить виджет «(.*)»$/,
      '$1',
    );
    const before = await boardOrder(page);

    await handle.focus();
    await page.keyboard.press('ArrowLeft'); // уже первая карточка
    await expect(page.locator('[data-reorder-status]')).toHaveText(`«${label}» — уже в начале`);
    expect(await boardOrder(page)).toEqual(before);
    await expect(handle).toBeFocused();
  });
});
