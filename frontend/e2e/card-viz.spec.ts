import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Переключатель типа графика на карточках фида. Контрол — не новый: `EditWidgetDialog` показывает
 * VariantCarousel, как только карточка объявит больше одного варианта. Эти KPI-карточки не
 * объявляли ни одного, поэтому типа графика было не выбрать (прод-фидбек владельца).
 */
test('KPI-карточка Обзора даёт выбрать столбцы вместо линии', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'редактор карточки — desktop-хром');
  await bootDemo(page, '/');

  // `section[data-widget-size]` — сама плитка: голый `section` матчит ещё и секцию-обёртку ряда.
  const card = page.locator('section[data-widget-size]').filter({
    has: page.getByRole('heading', { name: 'Реакции', exact: true }),
  });
  await expect(card).toBeVisible();
  // Исходно карточка рисует СТОЛБЦЫ: «Реакции» — дискретная суточная сумма, и bar здесь дефолт
  // (#461). BarChart кладёт в svg прямоугольники-колонки, у искры их нет.
  await expect.poll(async () => card.locator('svg rect').count()).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Меню виджета «Реакции»' }).click();
  await page.getByRole('menuitem', { name: 'Изменить' }).click();
  const editor = page.getByRole('dialog', { name: 'Настройка виджета «Реакции»' });
  await expect(editor).toBeVisible();

  // Карусель вариантов есть и переключает представление в обе стороны — проверяем обратный
  // переход (столбцы → линия): именно он доказывает, что выбор пользователя жив после #461.
  await expect(editor.getByRole('button', { name: 'Тип виджета: Линия', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Тип виджета: Линия', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);

  // Искра вернулась — колонок в svg не осталось.
  await expect.poll(async () => card.locator('svg rect').count()).toBe(0);
  // Хедлайн карточки на месте — меняется только примитив под ним, не анатомия.
  await expect(card.getByRole('heading', { name: 'Реакции', exact: true })).toBeVisible();
});

test('карточка IG-Обзора тоже даёт выбрать столбцы', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'редактор карточки — desktop-хром');
  await bootDemo(page, '/instagram');

  const card = page.locator('section[data-widget-size]').filter({
    has: page.getByRole('heading', { name: 'Просмотры', exact: true }),
  });
  await expect(card).toBeVisible();
  await expect(card.locator('svg rect')).toHaveCount(0);

  await page.getByRole('button', { name: 'Меню виджета «Просмотры»' }).click();
  await page.getByRole('menuitem', { name: 'Изменить' }).click();
  const editor = page.getByRole('dialog', { name: 'Настройка виджета «Просмотры»' });
  await editor.getByRole('button', { name: 'Тип виджета: Столбцы', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);

  await expect.poll(async () => card.locator('svg rect').count()).toBeGreaterThan(0);
});
