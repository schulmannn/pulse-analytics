import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * U7 — разбивки, являющиеся ЧАСТЯМИ ЦЕЛОГО, печатают «значение · доля». До этого строка несла
 * голый абсолют, а длина бара мерилась от максимума строки: первый бар всегда во всю ширину, и
 * «Подписчики 71» читалось неотличимо от процента.
 *
 * Демо-фикстуры дают ровно этот случай (views_by_source 71/16/9/4 при сумме 100), поэтому доли
 * проверяются точным текстом. Средние («Ср. охват по типу») долей не получают — их сумма ничего
 * не значит.
 *
 * Boot из client-side demo-фикстур (pulse_demo) — реальных Telegram-кредов в раннере нет.
 */

/** «71 · 71%» / «1 310 · 54.3%» — значение, разделитель, доля (целая — без хвостовой «.0»). */
const SHARE_ROW = /\d\s*·\s*\d+([.,]\d)?%/;

const cardBy = (page: import('@playwright/test').Page, title: string) =>
  page
    .locator('section[data-widget-size]')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });

test.describe('Разбивки-части целого: «значение · доля»', () => {
  test('строки аудитории несут долю от полной суммы', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/analytics?tab=audience');

    // Целая доля печатается без «.0» — «71%», не «71.0%» (приёмка волны).
    // «Источники» — одна карточка с переключателем метрики: просмотры и новые подписчики это одно
    // измерение, поэтому доля проверяется на ОБЕИХ вкладках, а не на двух отдельных карточках.
    const sources = cardBy(page, 'Источники');
    await expect(sources).toContainText('71 · 71%');
    await expect(cardBy(page, 'Языки аудитории')).toContainText('68 · 68%');
    await expect(cardBy(page, 'Тональность реакций')).toContainText(SHARE_ROW);
    // Именно кнопка: слово «Подписчики» встречается и строкой данных во вкладке просмотров.
    await sources.getByRole('button', { name: 'Подписчиков' }).click();
    await expect(sources).toContainText(SHARE_ROW);
  });

  test('средние остаются без долей', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/analytics?tab=content');

    // Часть целого — доля есть.
    await expect(cardBy(page, 'Состав вовлечённости')).toContainText(SHARE_ROW);
    // Карточка условная (рендерится только при непустых данных), а `not.toContainText` на нулевом
    // наборе проходит мгновенно — сначала требуем её существования, иначе единственная защита от
    // «доля приклеилась к средним» молча выключилась бы вместе с карточкой.
    await expect(cardBy(page, 'Ср. охват по типу')).toBeVisible();
    // Средний охват публикации по типу — не часть целого, доля была бы враньём.
    await expect(cardBy(page, 'Ср. охват по типу')).not.toContainText(SHARE_ROW);
  });
});
