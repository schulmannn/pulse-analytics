import { expect, test } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

/**
 * U7 — разбивки, являющиеся ЧАСТЯМИ ЦЕЛОГО, показывают долю. До этого строка несла голый абсолют,
 * а длина бара мерилась от максимума строки: первый бар всегда во всю ширину, и «Подписчики 71»
 * читалось неотличимо от процента.
 *
 * СМЕНА КОНТРАКТА (R1). Раньше значение и доля печатались ОДНОЙ склейкой «71 · 71%» — сюда же
 * попадали и приписки вроде «1,3 тыс · 12 постов», и разделитель «·» переставал что-либо значить.
 * Теперь у строки анатомия таблицы: шапка колонок, ранг, значение и доля в СВОИХ колонках. Поэтому
 * проверки ниже требуют доли отдельным узлом рядом со значением, а не подстроки со склейкой:
 * старая форма («71 · 71%») теперь означала бы возврат к неразличимой правой колонке.
 *
 * Демо-фикстуры дают ровно этот случай (views_by_source 71/16/9/4 при сумме 100), поэтому доли
 * проверяются точным текстом. Средние («Ср. охват по типу») долей не получают — их сумма ничего
 * не значит.
 *
 * Boot из client-side demo-фикстур (pulse_demo) — реальных Telegram-кредов в раннере нет.
 */

/** Доля отдельной ячейкой: «71%» / «54.3%» (целая — без хвостовой «.0»). */
const SHARE_CELL = /^\d+([.,]\d)?%$/;

const cardBy = (page: import('@playwright/test').Page, title: string) =>
  page
    .locator('section[data-widget-size]')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });

test.describe('Разбивки-части целого: значение и доля в своих колонках', () => {
  test('строки аудитории несут долю от полной суммы', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/analytics?tab=audience');

    // Целая доля печатается без «.0» — «71%», не «71.0%» (приёмка волны).
    // «Источники» — одна карточка с переключателем метрики: просмотры и новые подписчики это одно
    // измерение, поэтому доля проверяется на ОБЕИХ вкладках, а не на двух отдельных карточках.
    const sources = cardBy(page, 'Источники');
    await expect(sources).toContainText('71%');
    // Шапка называет обе колонки: без неё «71» — число неизвестно чего.
    await expect(sources.locator('[data-breakdown-header]')).toContainText('Источник');
    await expect(sources.locator('[data-breakdown-header]')).toContainText('Просмотры');
    await expect(cardBy(page, 'Языки аудитории')).toContainText('68%');
    await expect(cardBy(page, 'Тональность реакций')).toContainText(/\d+([.,]\d)?%/);
    // Именно кнопка: слово «Подписчики» встречается и строкой данных во вкладке просмотров.
    await sources.getByRole('button', { name: 'Подписчиков' }).click();
    await expect(sources.locator('[data-breakdown-header]')).toContainText('Подписчики');
  });

  test('средние остаются без долей и без колонки доли', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/analytics?tab=content');

    // Часть целого — доля есть.
    await expect(cardBy(page, 'Состав вовлечённости')).toContainText(/\d+([.,]\d)?%/);
    // Карточка условная (рендерится только при непустых данных), а `not.toContainText` на нулевом
    // наборе проходит мгновенно — сначала требуем её существования, иначе единственная защита от
    // «доля приклеилась к средним» молча выключилась бы вместе с карточкой.
    const avgReach = cardBy(page, 'Ср. охват по типу');
    await expect(avgReach).toBeVisible();
    // Средний охват публикации по типу — не часть целого, доля была бы враньём: у списка нет ни
    // колонки доли, ни её заголовка.
    await expect(avgReach.locator('[data-breakdown-header]')).not.toContainText('Доля');
    await expect(avgReach).not.toContainText(/\d+([.,]\d)?%/);
  });

  test('гео-карточка IG: шапка, ранг, доля своей колонкой и ссылка на полный список', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Демография — desktop-first поверхность');
    await bootDemo(page, '/instagram/audience');

    const countries = cardBy(page, 'Топ стран');
    const header = countries.locator('[data-breakdown-header]');
    await expect(header).toContainText('Страна');
    await expect(header).toContainText('Подписчики');
    await expect(header).toContainText('Доля');

    // Ранг — первая ячейка первой строки; доля — последняя. Обе читаются как ОТДЕЛЬНЫЕ узлы:
    // именно это отличает таблицу от прежней склейки в одном span.
    const firstRow = countries.locator('[data-breakdown-header] ~ div').first();
    await expect(firstRow.locator('span').first()).toHaveText('1');
    await expect(firstRow.locator('span').last()).toHaveText(SHARE_CELL);

    // Футер ведёт на полный список — «+N ещё» называл спрятанное, но идти за ним было некуда.
    // Один клик = один переход: карточка сама несёт drill, и ссылка не должна открывать второй.
    const more = countries.getByRole('link', { name: /^Все 12 стран/ });
    await expect(more).toBeVisible();
    await more.click();
    await expect(page).toHaveURL(/\/metrics\/ig-countries$/);
    await expect(page.getByRole('heading', { name: 'Все страны' })).toBeVisible();
  });

  test('шапка и ранг не выдавливают строки за кромку карточек', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Фикс-тайлы — desktop-поверхность');
    await bootDemo(page, '/instagram/audience');
    // Бюджет строк обязан вычитать шапку. Если этого не делать, список рисует на строку больше,
    // чем тайл держит, и карточка получает внутренний скролл — тот самый клиппинг (N1).
    expect(await overflowingCards(page)).toEqual([]);
  });
});
