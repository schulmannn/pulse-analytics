import { expect, test, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * D7 (аудит #554) — ИСКРА В НАРРАТИВЕ ИМЕЕТ МЕСТО В МАКЕТЕ.
 *
 * Искра формировалась последним сегментом предложения, после точки. Когда предложение заполняло
 * строку, inline-block переносился ОДИН на новую (TG); когда места хватало — болтался в пробеле
 * после точки (IG). Без рамки, оси и подписи такая линия читается случайным росчерком.
 *
 * Теперь она стоит вплотную за числом, которое объясняет, и связана с ним неразрывной обёрткой:
 * пара переносится как одно слово. Проверяется РЕНДЕР, а не разметка: искра на одной строке со
 * своим числом и никогда не начинает строку. Соседа ищем по документу, поэтому снятая обёртка
 * гейт не обманет — искра всё равно найдётся, и упадёт именно проверка раскладки.
 */

type SparkFit = { number: string; sameLine: boolean; startsLine: boolean };

async function sparkFit(page: Page): Promise<SparkFit[]> {
  return page.evaluate(() => {
    /** Ближайший ПРЕДШЕСТВУЮЩИЙ искре элемент абзаца с непустым текстом — её число. */
    const prevTextEl = (para: Element, svg: Element): Element | null => {
      const els = [...para.querySelectorAll('*')];
      for (let k = els.indexOf(svg) - 1; k >= 0; k -= 1) {
        const el = els[k];
        if (el.contains(svg)) continue;
        if ((el.textContent ?? '').trim()) return el;
      }
      return null;
    };

    const out: SparkFit[] = [];
    for (const svg of document.querySelectorAll<SVGSVGElement>('p svg[data-chart-curve="smooth"]')) {
      const para = svg.closest('p');
      if (!para) continue;
      const num = prevTextEl(para, svg);
      if (!num) continue;
      const nr = num.getBoundingClientRect();
      const sr = svg.getBoundingClientRect();
      // Одна строка: вертикальные проекции пересекаются больше чем наполовину меньшей высоты.
      const overlap = Math.min(nr.bottom, sr.bottom) - Math.max(nr.top, sr.top);
      out.push({
        number: (num.textContent ?? '').trim().slice(0, 16),
        sameLine: overlap > Math.min(nr.height, sr.height) * 0.5,
        // Начинает строку — значит левый край искры пришёлся на левый край абзаца.
        startsLine: sr.left - para.getBoundingClientRect().left < 2,
      });
    }
    return out;
  });
}

test.describe('инлайн-искра нарратива', () => {
  test.beforeEach(async ({ browserName: _b }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Нарратив-карточка — desktop-раскладка');
  });

  // ТОЛЬКО IG. В TG-карточке «Неделя канала» инлайн-искры больше нет вовсе (аудит #554, ТЗ-11):
  // ритм недели показывает полоска на 14 дней, а мысль стоит текстом без вклеенных графиков.
  // IG-виджет не менялся и по-прежнему стережёт пару «число + искра».
  for (const route of ['/instagram'] as const) {
    test(`${route}: искра стоит на строке своего числа и не начинает строку`, async ({ page }) => {
      await bootDemo(page, route);
      const found = await sparkFit(page);
      // Сначала — что мерили: без искр проверка прошла бы вхолостую.
      expect(found.length, `искры должны найтись на ${route}`).toBeGreaterThan(0);
      for (const spark of found) {
        expect(spark.sameLine, `искра числа «${spark.number}» на его строке`).toBe(true);
        expect(spark.startsLine, `искра числа «${spark.number}» не начинает строку`).toBe(false);
      }
    });
  }

  test('узкая колонка не отрывает искру от числа', async ({ page }) => {
    await bootDemo(page, '/instagram');
    // Сужаем окно так, чтобы предложения переносились в разных местах: пара «число + искра»
    // обязана уезжать на новую строку ЦЕЛИКОМ, а не оставлять искру одну.
    for (const width of [1280, 1100, 960, 820]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      const found = await sparkFit(page);
      expect(found.length, `ширина ${width}px: искры должны найтись`).toBeGreaterThan(0);
      expect(
        found.filter((s) => !s.sameLine).map((s) => s.number),
        `ширина ${width}px: искра оторвалась от числа`,
      ).toEqual([]);
    }
  });
});
