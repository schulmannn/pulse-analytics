import { expect, test, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * D11 (аудит #554) — ИМЯ НЕ РЕЖЕТСЯ, ПОКА В СТРОКЕ ЕСТЬ МЕСТО.
 *
 * Числовые колонки «Товаров» стояли на фикс-ширинах (`w-20` = 80px, `w-36` = 144px) и занимали
 * своё место независимо от содержимого: имени доставалось 221px из 501px строки, и оно резалось
 * («Кофемашина автоматическая D…») при полупустой правой части.
 *
 * Проверяется не «имя целиком» — длинное имя честно режется и на широкой колонке, — а ДОЛЯ СТРОКИ,
 * ОТДАННАЯ ИМЕНИ: на фикс-ширинах это 221/501 (44%), на треках по содержимому — 292/501 (58%).
 * Второй тест стережёт сами треки: вернувшиеся 80/144px видны сразу.
 */

type RowFit = { name: string; nameW: number; rowW: number };

async function productRows(page: Page): Promise<RowFit[]> {
  return page.evaluate(() => {
    const out: RowFit[] = [];
    for (const li of document.querySelectorAll<HTMLElement>('section[data-widget-size] li')) {
      const cells = [...li.children] as HTMLElement[];
      if (cells.length < 4) continue;
      // Имя — единственная ячейка с truncate; остальные держат числа.
      const name = cells.find((c) => c.className.includes('truncate'));
      if (!name) continue;
      out.push({
        name: (name.textContent ?? '').trim().slice(0, 28),
        nameW: Math.round(name.getBoundingClientRect().width),
        rowW: Math.round(li.getBoundingClientRect().width),
      });
    }
    return out;
  });
}

test.describe('колонка имени забирает остаток строки', () => {
  test.beforeEach(async ({ browserName: _b }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Ширины колонок — desktop-раскладка');
  });

  test('/sklad: имени достаётся больше половины строки', async ({ page }) => {
    await bootDemo(page, '/sklad', { msFixtures: true });
    await expect(page.getByRole('heading', { name: 'Товары', exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });
    const rows = await productRows(page);
    // Сначала — что мерили.
    expect(rows.length, `строки товаров должны найтись: ${JSON.stringify(rows)}`).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.nameW / row.rowW, `доля имени в «${row.name}» (${JSON.stringify(row)})`).toBeGreaterThan(0.5);
    }
  });

  test('фикс-ширины ушли: в треках сетки нет 80px и 144px', async ({ page }) => {
    await bootDemo(page, '/sklad', { msFixtures: true });
    const tracks = await page.evaluate(() => {
      const out: string[] = [];
      for (const ul of document.querySelectorAll<HTMLElement>('section[data-widget-size] ul')) {
        const cs = getComputedStyle(ul);
        if (cs.display !== 'grid') continue;
        const cols = cs.gridTemplateColumns.split(' ').filter(Boolean);
        if (cols.length >= 4) out.push(cols.join('|'));
      }
      return out;
    });
    expect(tracks.length, 'сетка списка должна найтись').toBeGreaterThan(0);
    for (const track of tracks) {
      const px = track.split('|').map((v) => Number.parseFloat(v));
      // 80px и 144px — те самые фикс-ширины, из-за которых имя и резалось.
      expect(
        px.some((v) => Math.abs(v - 80) < 0.6),
        `трек 80px остался: ${track}`,
      ).toBe(false);
      expect(
        px.some((v) => Math.abs(v - 144) < 0.6),
        `трек 144px остался: ${track}`,
      ).toBe(false);
    }
  });
});
