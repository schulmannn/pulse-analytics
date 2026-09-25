import { expect, test, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * ПРАВИЛО ЗАПОЛНЕНИЯ РЯДА (аудит #554, D1/D16) — ряд сетки виджетов не имеет права заканчиваться
 * дырой. Сетка шестиколоночная, размеры карточек 2/3/6, поэтому M+S занимают пять колонок из шести
 * и шестая зияет посреди страницы.
 *
 * До правила дыру затыкали ТРИ разных механизма, и все — только в хвосте: JS в WidgetGroup, CSS-хак
 * `:last-child:nth-child(odd)` в TgAnalytics и ничто на двенадцати поверхностях с голой сеткой
 * (СДЭК, Метрика, Rusender, МойСклад). Здесь проверяется общий инвариант на всех них разом.
 *
 * Спек НЕ вакуумный: он отдельно считает, сколько карточек правило реально растянуло, и требует,
 * чтобы таких было хотя бы несколько. Без useRowFill счётчик равен нулю И появляются дыры — падают
 * обе половины, а не одна.
 */

type RowGap = { grid: string; rowTop: number; gapPx: number; last: string };
type Audit = { gaps: RowGap[]; stretched: number; grids: number; rows: number };

/** Читаем раскладку глазами браузера: ряд = карточки с одинаковой вершиной, дыра = зазор справа. */
async function auditGrids(page: Page): Promise<Audit> {
  return page.evaluate(() => {
    const out: {
      gaps: { grid: string; rowTop: number; gapPx: number; last: string }[];
      stretched: number;
      grids: number;
      rows: number;
    } = { gaps: [], stretched: 0, grids: 0, rows: 0 };

    const nameOf = (el: HTMLElement) =>
      el.querySelector('h2, h3, [data-widget-title]')?.textContent?.trim().slice(0, 40) ??
      el.getAttribute('data-widget-size') ??
      el.tagName.toLowerCase();

    for (const grid of document.querySelectorAll<HTMLElement>('[data-widget-grid]')) {
      const cs = getComputedStyle(grid);
      const tracks = cs.gridTemplateColumns.split(' ').filter(Boolean);
      // Одноколоночная (мобильная) раскладка рядов в этом смысле не имеет.
      if (tracks.length < 2) continue;
      const kids = ([...grid.children] as HTMLElement[]).filter(
        (el) => el.offsetWidth > 0 && el.offsetParent !== null,
      );
      if (kids.length === 0) continue;
      out.grids += 1;
      out.stretched += kids.filter((el) => el.style.gridColumn !== '').length;

      const right = grid.getBoundingClientRect().right - Number.parseFloat(cs.paddingRight || '0');
      const rows = new Map<number, HTMLElement[]>();
      for (const el of kids) {
        const top = Math.round(el.getBoundingClientRect().top);
        const bucket = rows.get(top);
        if (bucket) bucket.push(el);
        else rows.set(top, [el]);
      }
      for (const [top, row] of rows) {
        out.rows += 1;
        row.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        const last = row[row.length - 1];
        // Ряд извиняется, только если В НЁМ НЕТ НИ ОДНОЙ карточки, которую можно растянуть.
        //
        // Раньше здесь стояло то же условие, что и в самом правиле — «не подходит последняя,
        // значит ряд законный», — и гейт повторял ошибку реализации вместо того, чтобы её ловить:
        // дыра в 230px на Аналитике жила при зелёном тесте (аудит #554, проход №2, N4).
        const fixed = (el: HTMLElement) =>
          el.hasAttribute('data-widget-user-sized') || el.hasAttribute('data-widget-no-stretch');
        if (row.every(fixed)) continue;
        const gapPx = right - last.getBoundingClientRect().right;
        // 4px — субпиксельная сдача округления треков, а не дыра: колонка тут ≥ 150px.
        if (gapPx > 4) {
          out.gaps.push({
            grid: grid.getAttribute('id') ?? grid.className.slice(0, 40),
            rowTop: top,
            gapPx: Math.round(gapPx),
            last: nameOf(last),
          });
        }
      }
    }
    return out;
  });
}

/**
 * Снимаем раскладку, КОГДА ОНА УСТОЯЛАСЬ: высоты графиков доезжают через ResizeObserver,
 * и под нагрузкой (несколько worker'ов Playwright на одном CPU) фиксированного settle в bootDemo
 * не хватает — замер ловил кадр посреди пере-раскладки. Ждём два совпавших подряд замера.
 */
async function settledAudit(page: Page): Promise<Audit> {
  let prev = '';
  let audit = await auditGrids(page);
  for (let i = 0; i < 40; i++) {
    const sig = JSON.stringify(audit);
    if (sig === prev) return audit;
    prev = sig;
    await page.waitForTimeout(250);
    audit = await auditGrids(page);
  }
  return audit;
}

/** Демо-маршруты со своими сетками: TG-группы (WidgetGroup) + голые сетки МС и Метрики. */
const ROUTES: { route: string; opts?: { msFixtures?: boolean } }[] = [
  { route: '/' },
  { route: '/analytics?group=audience' },
  { route: '/analytics?group=content' },
  { route: '/sklad', opts: { msFixtures: true } },
  { route: '/sklad/clients', opts: { msFixtures: true } },
  { route: '/metrika', opts: { msFixtures: true } },
];

test.describe('заполнение рядов сетки виджетов', () => {
  test.beforeEach(async ({ browserName: _b }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Правило ряда — шестиколоночная desktop-раскладка');
  });

  test('ни один ряд не заканчивается пустой колонкой', async ({ page }) => {
    test.setTimeout(180_000); // шесть маршрутов с отдельным bootDemo на каждый
    const seen: Audit = { gaps: [], stretched: 0, grids: 0, rows: 0 };
    for (const { route, opts } of ROUTES) {
      await bootDemo(page, route, opts);
      const audit = await settledAudit(page);
      seen.gaps.push(...audit.gaps.map((g) => ({ ...g, grid: `${route} · ${g.grid}` })));
      seen.stretched += audit.stretched;
      seen.grids += audit.grids;
      seen.rows += audit.rows;
    }

    // Сначала — что мерили вообще: пустой обход прошёл бы «зелёным» ни на чём.
    expect(seen.grids, 'сетки должны найтись на этих маршрутах').toBeGreaterThan(4);
    expect(seen.rows, 'ряды должны найтись').toBeGreaterThan(8);
    // Сам инвариант: ни одного ряда с пустой колонкой в хвосте.
    expect(seen.gaps, JSON.stringify(seen.gaps, null, 2)).toEqual([]);
    // И правило должно РАБОТАТЬ, а не просто не мешать: без useRowFill здесь ноль.
    expect(seen.stretched, 'правило должно было растянуть хотя бы несколько карточек').toBeGreaterThan(2);
  });

  test('сохранённый размер карточки правило не переписывает', async ({ page }) => {
    await bootDemo(page, '/');
    const userSized = await page.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>('[data-widget-grid] > [data-widget-user-sized]')];
      return els.map((el) => el.style.gridColumn);
    });
    // Каких-то user-sized карточек в демо может и не быть — но если есть, инлайна на них нет.
    expect(userSized.filter((v) => v !== '')).toEqual([]);
  });
});
