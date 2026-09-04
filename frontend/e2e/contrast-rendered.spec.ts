import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * ВЫЧИСЛЕННЫЙ контраст отрисованной страницы — второй, независимый от axe гейт.
 *
 * Зачем он рядом с `a11y-contrast.spec.ts`, который уже гоняет axe:
 *  • axe ПРОПУСКАЕТ `aria-hidden` элементы целиком. Глифы-аффордансы (стрелка сортировки, значок
 *    тренда) — это видимые пиксели, которые он не проверит никогда: так и жил `↕` на 2.4:1 в обеих
 *    темах, мимо зелёного гейта;
 *  • axe СДАЁТСЯ на полупрозрачных фонах и пишет `incomplete`, а прежний гейт смотрел только на
 *    `violations` — то есть молча выбрасывал именно те случаи, где фон сложный;
 *  • axe покрывал четыре маршрута; светлая тема при этом жила на правах отложенной, и по остальным
 *    полутора десяткам поверхностей её никто не мерил.
 *
 * Здесь фон считается ЧЕСТНО: цвет прогоняется через canvas (иначе `oklab(...)`, в который Tailwind
 * разворачивает полупрозрачные утилиты вроде `bg-muted` под альфой, просто не разобрать), а слои
 * складываются вверх по дереву до первого непрозрачного. Пороги — WCAG: обычный текст 4.5, крупный
 * 3.0, `aria-hidden`-глиф считается нетекстовым индикатором (1.4.11) и держит 3.0.
 */

const ROUTES = [
  '/',
  '/analytics',
  '/analytics?tab=audience',
  '/analytics?tab=content',
  '/posts',
  '/mentions',
  '/home',
  '/reports',
  '/instagram',
  '/sklad',
  '/metrics/views',
  '/metrics/subscribers',
  '/settings',
  '/connect',
];

interface Finding {
  text: string;
  size: number;
  ratio: number;
  need: number;
  cls: string;
}

/** Живёт строкой: выполняется в странице, где нет ни сборки, ни импортов. */
const PROBE = `(() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
  };
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
  const lum = (p) =>
    p.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
     .reduce((a, x, i) => a + x * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
  };
  const bgOf = (el) => {
    const stack = [];
    let n = el;
    while (n) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) stack.push(c);
      if (c[3] === 1) break;
      n = n.parentElement;
    }
    let base = [1, 1, 1];
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const text = (el.textContent || '').trim();
    if (!text || el.children.length) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const decorative = el.closest('[aria-hidden="true"]') != null;
    const need = decorative || size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const bg = bgOf(el);
    const r = ratio(over(rgba(cs.color), bg), bg);
    if (r >= need) continue;
    out.push({
      text: text.slice(0, 28),
      size,
      ratio: r,
      need,
      cls: (el.getAttribute('class') || '').slice(0, 80),
    });
  }
  const seen = new Set();
  return out.filter((f) => {
    const key = f.cls + '|' + f.ratio + '|' + f.size;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
})()`;

for (const theme of ['light', 'dark'] as const) {
  for (const route of ROUTES) {
    test(`rendered contrast (${theme}): ${route}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'палитра не зависит от брейкпоинта');
      await bootDemo(page, route, { theme });
      const findings = (await page.evaluate(PROBE)) as Finding[];
      expect(
        findings,
        `${theme} ${route}: контраст ниже порога\n${JSON.stringify(findings, null, 2)}`,
      ).toEqual([]);
    });
  }
}
