import { expect, test, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * ОДНА АНАТОМИЯ S-КАРТОЧКИ (аудит #554, D9). Три соседние карточки одного размера держали три
 * разные композиции: «Ср. охват» — голое число, «Реакции» — число со стрелкой в строке,
 * «Вовлечённость» — число ПО ЦЕНТРУ с дельтой строкой ниже. Ряд читался как три разных типа
 * карточек.
 *
 * Здесь пришпилено то, что видно глазом: у всех трёх число стоит на одной левой кромке и у всех
 * трёх слот дельты говорит. Проверка идёт по РЕНДЕРУ, а не по классам, — центрирование вернулось бы
 * незаметно для любой проверки по разметке.
 */

const TG_CARDS = ['Ср. охват', 'Реакции', 'Вовлечённость'];
const IG_CARDS = ['Просмотры', 'Взаимодействия', 'Вовлечённость'];

/** Левая кромка КРУПНОГО числа относительно левой кромки карточки + текст слота дельты. */
async function anatomy(page: Page, titles: string[]) {
  return page.evaluate((names) => {
    const out: { title: string; inset: number | null; delta: string | null; basis: string | null }[] = [];
    for (const name of names) {
      const heading = [...document.querySelectorAll<HTMLElement>('h2, h3')].find(
        (h) => h.textContent?.trim() === name,
      );
      const card = heading?.closest<HTMLElement>('section[data-widget-size]');
      if (!card) {
        out.push({ title: name, inset: null, delta: null, basis: null });
        continue;
      }
      const value = card.querySelector<HTMLElement>('[data-kpi-value]');
      const line = value?.parentElement ?? null;
      const cardBox = card.getBoundingClientRect();
      // Слот дельты — всё, что стоит в одной строке с числом ПОСЛЕ него.
      const slots = line == null || value == null ? [] : ([...line.children] as HTMLElement[]).filter((el) => el !== value);
      out.push({
        title: name,
        inset: value ? Math.round(value.getBoundingClientRect().left - cardBox.left) : null,
        delta:
          slots
            .map((el) => (el.textContent ?? '').trim())
            .join(' ')
            .replace(/\u00a0/g, ' ')
            .trim() || null,
        // ОСНОВАНИЕ (R2): подсказка слота — «против <даты>: <число>» либо причина, почему базы нет.
        basis: slots.map((el) => el.getAttribute('title') ?? '').find((t) => t.length > 0) ?? null,
      });
    }
    return out;
  }, titles);
}

test.describe('анатомия S-карточек', () => {
  test.beforeEach(async ({ browserName: _b }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Ряд S-карточек — desktop-раскладка');
  });

  for (const [route, titles] of [
    ['/', TG_CARDS],
    ['/instagram', IG_CARDS],
  ] as const) {
    test(`${route}: число на одной кромке, слот дельты говорит у всех`, async ({ page }) => {
      await bootDemo(page, route);
      // IG-кластер и его фикстуры едут ЛЕНИВЫМ чанком: фиксированного settle в bootDemo
      // на холодном dev-сервере не хватает, и замер ловил пустую страницу. Ждём сами карточки.
      for (const title of titles) {
        await expect(page.getByRole('heading', { name: title, exact: true }).first()).toBeVisible({
          timeout: 25_000,
        });
      }
      const rows = await anatomy(page, [...titles]);
      const found = rows.filter((r) => r.inset != null);
      // Сначала — что мерили: пустой обход прошёл бы «зелёным» ни на чём.
      expect(found.length, `карточки ряда должны найтись: ${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(2);

      // Одна левая кромка: центрированная карточка отъезжает от неё на десятки пикселей.
      const insets = found.map((r) => r.inset as number);
      const spread = Math.max(...insets) - Math.min(...insets);
      expect(spread, `левые кромки чисел: ${JSON.stringify(found)}`).toBeLessThanOrEqual(2);

      // И слот дельты не молчит ни у одной: «нет базы», «0%» или стрелка с процентом.
      for (const row of found) {
        expect(row.delta, `слот дельты у «${row.title}»`).toMatch(/нет базы|\d|↑|↓/);
      }

      // R2: слот НАЗЫВАЕТ основание — даты базы и её число либо причину, почему базы нет.
      // Без этого «↑4.5%» нечем проверить, не уходя со страницы.
      for (const row of found) {
        expect(row.basis, `основание дельты у «${row.title}»`).toMatch(
          /^против .+: .+$|^окно |^свой период |^архив короче /,
        );
      }
    });
  }
});
