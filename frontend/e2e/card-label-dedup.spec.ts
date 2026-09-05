import { expect, test, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * ПОДПИСЬ НЕ ПОВТОРЯЕТ ЗАГОЛОВОК КАРТОЧКИ (аудит #554, D8).
 *
 * На IG-обзоре карточка «Охват» печатала своё имя ДВАЖДЫ: в шапке и второй раз серой подписью над
 * числом 146.4k. Правило против этого жило в ChartCardBody с самого аудита, но было мёртвым: оно
 * сверяется с `ChartCardTitleContext`, а тот объявлялся ТОЛЬКО в оверлее развёртки — на лицо
 * карточки заголовок не доходил и правило молча выключалось на каждой карточке продукта.
 * Юнит-тест этого не видел, потому что подавал контекст сам (ChartCardBody.duplicateLabel.test).
 *
 * Здесь пришпилено видимое глазом состояние живых досок: ни одна карточка не называет себя дважды.
 * Скрытые для AT подписи (sr-only у FeaturedKpi.labelHidden) — не дубль: их не видно, и по размеру
 * (1×1) они сюда не попадают.
 */

/** Видимая подпись над числом каждой карточки доски + заголовок её шапки. */
async function cardLabels(page: Page) {
  return page.evaluate(() => {
    const rows: { title: string; headline: string }[] = [];
    for (const card of document.querySelectorAll<HTMLElement>('section[data-widget-size]')) {
      const title = card.querySelector<HTMLElement>('h2, h3')?.textContent?.trim() ?? '';
      if (!title) continue;
      for (const headline of card.querySelectorAll<HTMLElement>('[data-chart-card-headline]')) {
        const value = headline.querySelector<HTMLElement>('[data-kpi-value]');
        // Подпись — всё, что стоит в колонке ВЫШЕ строки с крупным числом.
        const valueLine = value?.closest<HTMLElement>('[data-chart-card-headline] > *') ?? null;
        for (const el of [...headline.children] as HTMLElement[]) {
          if (el === valueLine) break;
          const box = el.getBoundingClientRect();
          // sr-only схлопнут в 1×1 — он невидим и дублем не читается.
          if (box.width <= 4 || box.height <= 4) continue;
          const text = (el.textContent ?? '').replace(/ /g, ' ').trim();
          if (text) rows.push({ title, headline: text });
        }
      }
    }
    return rows;
  });
}

test.describe('карточка не называет себя дважды', () => {
  test.beforeEach(async ({ browserName: _b }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Доска обзора — desktop-раскладка');
  });

  for (const [route, anchor] of [
    ['/instagram', 'Охват'],
    ['/', 'Просмотры'],
  ] as const) {
    test(`${route}: подпись над числом не повторяет заголовок карточки`, async ({ page }) => {
      await bootDemo(page, route);
      // IG-кластер и его фикстуры едут ЛЕНИВЫМ чанком (см. kpi-s-card-anatomy): ждём саму карточку.
      await expect(page.getByRole('heading', { name: anchor, exact: true }).first()).toBeVisible({
        timeout: 25_000,
      });
      const rows = await cardLabels(page);
      // Сначала — что мерили: доска без единой подписи прошла бы «зелёной» ни на чём. Карточка
      // «Охват» на ленте подписи не несёт вовсе, поэтому якорь — сам факт разобранных карточек.
      const cards = await page.locator('section[data-widget-size]').count();
      expect(cards, 'карточки доски должны найтись').toBeGreaterThanOrEqual(3);

      const dupes = rows.filter(
        (r) =>
          r.headline.toLowerCase() === r.title.toLowerCase() ||
          r.headline.toLowerCase().startsWith(`${r.title.toLowerCase()} · `),
      );
      expect(dupes, `дубли подписи: ${JSON.stringify(dupes)}`).toEqual([]);
    });
  }
});
