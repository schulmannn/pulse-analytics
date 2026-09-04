import { expect, test, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * ТЗ-11 (аудит #554) — «НЕДЕЛЯ КАНАЛА» ЧИТАЕТСЯ ЗА СЕКУНДУ.
 *
 * Было: вся карточка — проза в две колонки, числа спрятаны внутри предложений, леджер внизу
 * повторял базу и пик из текста. Чтобы сравнить неделю с прошлой, нужно было прочитать два абзаца.
 *
 * Стало два макета: L — число со сдвигом, полоска ритма на 14 дней и одна мысль; M и S — те же
 * величины списком фактов без графика. Здесь проверяется РЕНДЕР на живом демо, а не разметка:
 * что число видно, что полоска несёт три голоса, что в компакте графика нет и список влезает
 * в фикс-тайл без внутреннего скролла.
 */

const CARD = 'Неделя канала';

/** Карточка «Недели» на текущей странице — вместе с её геометрией и содержимым. */
async function weekCard(page: Page) {
  return page.evaluate((title) => {
    const card = [...document.querySelectorAll<HTMLElement>('section[data-widget-size]')].find(
      (s) => (s.querySelector('h2, h3')?.textContent ?? '').includes(title),
    );
    if (!card) return null;
    const body = card.querySelector<HTMLElement>('.widget-tile, .widget-tile-fixed');
    const tones = [...card.querySelectorAll('path[data-bar-tone]')].map((b) => b.getAttribute('data-bar-tone'));
    return {
      size: card.getAttribute('data-widget-size'),
      height: Math.round(card.getBoundingClientRect().height),
      tones,
      facts: body ? body.querySelectorAll('li').length : 0,
      // Внутренний скролл в фикс-тайле — канон плотности запрещает.
      innerScroll: body ? body.scrollHeight > body.clientHeight + 1 : false,
      // Инлайн-искры (data-chart-curve="smooth") в TG-карточке быть не должно.
      sparks: card.querySelectorAll('svg[data-chart-curve="smooth"]').length,
      text: (body?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  }, CARD);
}

/** Карточка гейтит свои запросы до подхода к вьюпорту — сначала показываем её. */
async function revealWeek(page: Page) {
  await page.evaluate((title) => {
    const card = [...document.querySelectorAll<HTMLElement>('section[data-widget-size]')].find(
      (s) => (s.querySelector('h2, h3')?.textContent ?? '').includes(title),
    );
    const scroller = document.querySelector<HTMLElement>('[data-dashboard-scroll]');
    if (card && scroller) scroller.scrollTop = Math.max(0, card.offsetTop - 120);
  }, CARD);
  await expect
    .poll(async () => (await weekCard(page))?.text.length ?? 0, { timeout: 25_000 })
    .toBeGreaterThan(40);
}

test.describe('«Неделя канала»', () => {
  test.beforeEach(async ({ browserName: _b }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Карточка недели — desktop-раскладка');
  });

  test('L на Обзоре: число, ритм двух недель и подсвеченный пик без скролла', async ({ page }) => {
    await bootDemo(page, '/');
    await revealWeek(page);
    const card = await weekCard(page);
    expect(card, 'карточка недели должна найтись').toBeTruthy();
    expect(card?.size).toBe('full');

    // Полоска ритма: обе недели одной серией, прошлая приглушена, пик выделен.
    expect(card?.tones.filter((t) => t === 'ghost').length, `тона: ${card?.tones.join(',')}`).toBeGreaterThan(3);
    expect(card?.tones).toContain('peak');

    // Число недели и сдвиг стоят наверху, а не внутри предложения.
    expect(card?.text).toMatch(/Просмотры за 7 дней/);
    expect(card?.text).toMatch(/[↑↓]\d/);
    // Слова «выше/ниже» рядом со стрелкой сняты: направление уже в глифе.
    expect(card?.text).not.toMatch(/ниже предыдущей|выше предыдущей/);

    // Леджер не повторяет то, что уже сказано наверху.
    expect(card?.text).not.toContain('Медианный охват');
    expect(card?.innerScroll, 'внутреннего скролла быть не должно').toBe(false);
    // Инлайн-искр в TG-карточке больше нет — ритм показывает полоска.
    expect(card?.sparks).toBe(0);
  });

  for (const [label, size] of [
    ['M', 'half'],
    ['S', 'third'],
  ] as const) {
    test(`${size} на Главной: форма B — факты списком без графика (${label})`, async ({ page }) => {
      await page.addInitScript((widgetSize) => {
        localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['week'] }));
        localStorage.setItem('pulse_widget_prefs', JSON.stringify({ 'home-week': { size: widgetSize } }));
      }, size);
      await bootDemo(page, '/home');
      await revealWeek(page);
      const card = await weekCard(page);
      expect(card, 'карточка недели должна найтись на Главной').toBeTruthy();
      expect(card?.size).toBe(size);

      // Ни полоски, ни искры: в 264px ритм вырождается.
      expect(card?.tones).toEqual([]);
      expect(card?.sparks).toBe(0);
      // Четыре факта числом вперёд.
      expect(card?.facts).toBe(4);
      expect(card?.text).toContain('просмотров за неделю');
      expect(card?.text).toContain('пик недели');
      // И всё это влезает в фикс-тайл.
      expect(card?.innerScroll, 'список обязан влезать в 264px').toBe(false);
    });
  }
});
