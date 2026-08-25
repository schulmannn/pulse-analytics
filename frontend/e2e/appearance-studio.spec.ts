import { test, expect, type Locator, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Студия «Оформление»: пользовательская тема поверх канона.
 *
 * Проверяется ровно то, что нельзя доказать юнит-тестом:
 *  • канон по умолчанию НЕ переопределяется (иначе все прочие гейты перестали бы быть авторитетными);
 *  • выбор доезжает до реальных вычисленных переменных документа, а не только до стора;
 *  • левая панель работает ПОВЕРХ приложения: страница с графиками остаётся видимой, а панель
 *    переживает переход по разделам — ради этого она и живёт в localStorage, а не в URL;
 *  • тема переживает перезагрузку И встаёт ДО первого кадра (как `.dark`, см. theme-fouc.spec);
 *  • «Сбросить» возвращает документ ровно к канону, не оставляя мёртвого <style>.
 */

const SETTINGS = '/settings?section=appearance';

const token = (page: Page, name: string) =>
  page.evaluate(
    (variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(),
    name,
  );

/** Открывает раздел настроек и ДОЖИДАЕТСЯ его: ленивый чанк на холодном vite едет дольше дефолта. */
const openSettings = async (page: Page, theme: 'light' | 'dark' = 'dark') => {
  await bootDemo(page, SETTINGS, { theme });
  const panel = page.locator('[data-settings-section="appearance"]');
  await panel.waitFor({ state: 'visible', timeout: 25_000 });
  return panel;
};

/** Открывает левую панель поверх страницы — тем же путём, что и пользователь: меню аккаунта. */
const openDock = async (page: Page, route = '/') => {
  await bootDemo(page, route, { theme: 'dark' });
  await page.getByRole('button', { name: 'Аккаунт' }).click();
  await page.getByRole('menuitem', { name: 'Оформление' }).click();
  const dock = page.locator('[data-appearance-dock]');
  await dock.waitFor({ state: 'visible', timeout: 25_000 });
  return dock;
};

/** Поле-карточка → выпадающий список → пункт. Подача студии — та же в панели и в настройках. */
const choose = async (page: Page, root: Locator, field: string, option: string) => {
  await root.getByRole('button').filter({ hasText: field }).first().click();
  await page.getByRole('menuitemradio', { name: option, exact: true }).click();
};

test.describe('студия оформления', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'студия не зависит от брейкпоинта');
  });

  test('по умолчанию канон не переопределяется ни одной переменной', async ({ page }) => {
    await openSettings(page);

    await expect(page.getByRole('heading', { name: 'Оформление' })).toBeVisible();
    expect(await page.locator('#pulse-appearance').count()).toBe(0);
    expect(await token(page, '--primary')).toBe('219 80% 68%');
  });

  test('выбор акцента, нейтрали, палитры и формы доезжает до документа', async ({ page }) => {
    const panel = await openSettings(page);

    await choose(page, panel, 'Акцент', 'Изумрудный');
    await choose(page, panel, 'Базовый цвет', 'Нейтральная');
    await choose(page, panel, 'Цвет графиков', 'Как акцент');
    await choose(page, panel, 'Скругление', '0 px');

    // Акцент ведёт и роль primary у графиков (--chart-role-primary → --brand-iris).
    await expect.poll(() => token(page, '--primary')).toMatch(/^15[0-9](\.\d)? /);
    await expect.poll(() => token(page, '--chart-role-primary')).toMatch(/^15[0-9](\.\d)? /);
    // Нейтраль двигает ТОН, но не светлоту: тёмная карточка остаётся на 8%.
    expect(await token(page, '--card')).toBe('0 0% 8%');
    // Радиус пересчитывает всё семейство, а не только --radius.
    expect(await token(page, '--radius')).toBe('0rem');
    expect(await token(page, '--radius-xl')).toBe('calc(0rem + 8px)');

    // Оценочные цвета остаются каноном — это семантика, а не вкус.
    expect(await token(page, '--brand-verdant')).toBe('147 45% 52%');
    expect(await token(page, '--brand-ember')).toBe('11 78% 62%');
  });

  test('шрифт применяется к документу и файл семейства реально доезжает', async ({ page }) => {
    const panel = await openSettings(page);

    await choose(page, panel, 'Шрифт', 'Lora');

    await expect.poll(() => token(page, '--font-sans')).toContain('Lora Variable');
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
      'Lora Variable',
    );
    // Само семейство раздаём мы (CSP font-src 'self'), поэтому проверяем не подпись, а загрузку —
    // и именно кириллицей: шрифт без кириллического подмножества «применился» бы вхолостую.
    const faces = await page.evaluate(async () => {
      const loaded = await document.fonts.load("16px 'Lora Variable'", 'Привет');
      return loaded.map((face) => face.status);
    });
    expect(faces).toContain('loaded');
  });

  test('панель работает поверх страницы и переживает переход по разделам', async ({ page }) => {
    const dock = await openDock(page, '/');

    // Панель слева, страница справа остаётся видимой — ради этого она и не модалка.
    const box = await dock.boundingBox();
    expect(box?.x ?? -1).toBeLessThan(40);
    expect(box?.width ?? 0).toBeLessThan(400);
    await expect(page.locator('main')).toBeVisible();

    await choose(page, dock, 'Акцент', 'Пурпурный');
    await expect.poll(() => token(page, '--chart-role-primary')).toMatch(/^30[0-9](\.\d)? /);

    // Переход по сайдбару: панель на месте (состояние в localStorage, а не в параметре запроса).
    await page.getByRole('link', { name: 'Аналитика' }).click();
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(dock).toBeVisible();
    expect(await token(page, '--chart-role-primary')).toMatch(/^30[0-9](\.\d)? /);

    await page.keyboard.press('Escape');
    await expect(dock).toBeHidden();
  });

  test('тема переживает перезагрузку и встаёт до первого кадра', async ({ page }) => {
    const panel = await openSettings(page);
    await choose(page, panel, 'Пресет', 'Цветение');
    await expect.poll(() => page.locator('#pulse-appearance').count()).toBe(1);
    const chosen = await token(page, '--primary');

    // Приложение не грузим вовсе: если переменная уже применена, её мог поставить ТОЛЬКО
    // прерисовочный бутстрап из <head> (та же логика доказательства, что в theme-fouc.spec).
    await page.route('**/src/main.tsx*', (route) => route.abort());
    await page.goto('/', { waitUntil: 'commit' });

    await expect.poll(() => token(page, '--primary')).toBe(chosen);
    expect(await page.evaluate(() => document.getElementById('root')?.innerHTML ?? null)).toBe('');
  });

  test('«Сбросить» возвращает документ к канону и снимает <style>', async ({ page }) => {
    const panel = await openSettings(page);
    await choose(page, panel, 'Пресет', 'Терминал');
    await expect.poll(() => token(page, '--radius')).toBe('0rem');

    await page.getByRole('button', { name: 'Сбросить' }).click();

    await expect.poll(() => page.locator('#pulse-appearance').count()).toBe(0);
    expect(await token(page, '--primary')).toBe('219 80% 68%');
    expect(await token(page, '--radius')).toBe('0.25rem');
    expect(await page.evaluate(() => localStorage.getItem('pulse_appearance'))).toBeNull();
  });
});
