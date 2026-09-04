import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Канон типографики — ДВА начертания, 400 и 500 (frontend/DESIGN_TOKENS.md, «Type scale»:
 * «text hierarchy by shade, not weight»). Третье начертание протекало ДВУМЯ каналами, и лечить
 * надо было оба (аудит #554, D18):
 *   • утилитой `font-semibold` (600) — заголовок тултипа, ранги и числа «Топ постов» на странице
 *     метрики, метки Radix select/dropdown;
 *   • браузерным bold у `<strong>`/`<b>` без явного `font-medium` — UA-правило `font-weight: bolder`
 *     от родителя с весом 500 даёт РОВНО 700, то есть самое тяжёлое начертание на экране появлялось
 *     там, где автор разметки вообще не думал о весе («лучший слот», «лучший день», «база без тегов»).
 * Утилиту ловит статикой `scripts/design-motion-lint.mjs`; здесь — то, что видит глаз: ни одного
 * текстового узла тяжелее 500 на реальном отрендеренном экране. Замер идёт по УЗЛАМ с текстом
 * (не по всем элементам), иначе пустые обёртки размывают счёт.
 *
 * `/instagram/content` СОЗНАТЕЛЬНО не в списке: таблицу контента Instagram параллельно переписывает
 * отдельная работа (D10) и `font-semibold` в её заголовках снимается там же. Маршрут добавляется в
 * ROUTES тем PR'ом, иначе два независимых PR правят один файл.
 */
const ROUTES = [
  '/',
  '/analytics?tab=audience',
  '/metrics/views',
  '/metrics/tg-heatmap',
  '/instagram',
  '/mentions',
];

type HeavyNode = { weight: string; tag: string; cls: string; text: string };

/** Все узлы с непустым текстом и вычисленным весом ≥ 600 — вместе с классом, чтобы упавший гейт
    сразу называл виновника, а не «где-то на странице». */
async function heavyTextNodes(page: Page): Promise<{ heavy: HeavyNode[]; textNodes: number }> {
  return page.evaluate(() => {
    const heavy: { weight: string; tag: string; cls: string; text: string }[] = [];
    let textNodes = 0;
    const walk = (el: Element) => {
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()) {
          const cs = getComputedStyle(el);
          textNodes += 1;
          if (Number(cs.fontWeight) >= 600) {
            heavy.push({
              weight: cs.fontWeight,
              tag: el.tagName,
              cls: (el.getAttribute('class') ?? '').slice(0, 80),
              text: (node.textContent ?? '').trim().slice(0, 32),
            });
          }
          break;
        }
      }
      for (const child of Array.from(el.children)) walk(child);
    };
    walk(document.body);
    return { heavy, textNodes };
  });
}

for (const route of ROUTES) {
  test(`${route} — ни одного текстового узла тяжелее 500`, async ({ page }) => {
    await bootDemo(page, route);
    const { heavy, textNodes } = await heavyTextNodes(page);
    // Сначала докажем, что мерили НЕ пустую страницу: гейт «нулей нет» на пустом DOM зелёный всегда.
    expect(textNodes, `на ${route} не отрендерился текст — замер веса был бы вакуумным`).toBeGreaterThan(30);
    expect(
      heavy.map((n) => `${n.weight} <${n.tag}> «${n.text}» :: ${n.cls}`),
      'канон допускает 400 и 500; 600/700 — третье начертание',
    ).toEqual([]);
  });
}

test('в демо не уходит ни одного запроса к /api/prefs', async ({ page }) => {
  // Публичное демо живёт БЕЗ серверной сессии: любой запрос за requireAuth возвращает 401 и сорит
  // в консоль (аудит #554, D18). Стаб bootDemo отвечает на всё под /api/ сам, поэтому проверять
  // статус бессмысленно — проверяем ФАКТ обращения: в демо запроса быть не должно вовсе.
  const prefsHits: string[] = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (p === '/api/prefs') prefsHits.push(`${r.method()} ${p}`);
  });
  await bootDemo(page, '/home');
  expect(prefsHits).toEqual([]);
});

test('в демо не уходит запрос статуса QR-сессии (он за requireAuth → 401)', async ({ page }) => {
  // Демо-канал объявлен `source: 'central'`, поэтому баннер здоровья Overview спрашивал
  // /api/tg/qr/status безусловно — и это был РЕАЛЬНЫЙ источник 401 в консоли демо (аудит D18
  // назвал вместо него /api/prefs, но тот давно закрыт своим гейтом). Закрыто фикстурой.
  const qrHits: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/tg/qr/status') qrHits.push(r.url());
  });
  await bootDemo(page, '/');
  expect(qrHits).toEqual([]);
});

test('подписи статистики поста — полное слово, пока контейнер не уже 280px', async ({ page }, testInfo) => {
  // Один словарь на четвёрку (lib/format POST_STAT_LABEL): «Просм.» и «Коммент.» рядом с целыми
  // «Реакции»/«Репосты» читались как случайность, а не как экономия места. Правило проверяется
  // ОБЕИМИ сторонами и по РЕАЛЬНОЙ ширине контейнера, а не по брейкпоинту окна: на desktop-1440
  // карточка широкая и слова целые, на tablet-768 строка статистики честно уже 280px (два столбца
  // в узкой колонке) и container query переключает форму — это и есть заявленное поведение.
  // Карточная витрина «Топ постов» существует с md (`hidden md:grid`) — ниже проверять нечего.
  test.skip((testInfo.project.use.viewport?.width ?? 0) < 768, 'карточная витрина живёт с md');
  await bootDemo(page, '/');
  const stats = page.locator('[data-post-stats]').first();
  await expect(stats).toBeVisible();
  const width = (await stats.boundingBox())?.width ?? 0;
  expect(width, 'строка статистики должна быть измерима').toBeGreaterThan(0);
  // useInnerText: обе формы лежат в DOM, невидимая скрыта `display:none` — textContent видел бы обе.
  const shown = (await stats.innerText()).replace(/\s+/g, ' ');
  if (width >= 280) {
    expect(shown, `ширина ${Math.round(width)}px — места хватает на полное слово`).toContain('Просмотры');
    expect(shown).toContain('Комментарии');
  } else {
    expect(shown, `ширина ${Math.round(width)}px — полное слово не помещается`).toContain('Просм.');
    expect(shown).toContain('Коммент.');
  }
  // Обе формы одновременно не показываются ни при какой ширине.
  expect(shown.includes('Просмотры') && shown.includes('Просм.')).toBe(false);
});
