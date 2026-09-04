import { expect, test, type Page } from '@playwright/test';

/**
 * Источник Rusender (email-рассылки) — прод-фича с НУЛЁМ e2e до этого файла (аудит #554).
 *
 * Здесь пришпилены два его собственных инварианта:
 *   • «События окна» и «Итоги рассылок» — ДВЕ независимые группы величин, которые нельзя
 *     складывать: открытия могут прийти на письма, отправленные до окна (тот же канон, что
 *     «Просмотры канала» ≠ «Просмотры публикаций» у Telegram);
 *   • «Рассылки» и «База» живут за фичефлагом RUSENDER_SURFACES — до сверки чисел с живыми
 *     данными их не видит никто, кроме включивших флаг.
 *
 * Boot БЕЗ pulse_demo: демо-фикстуры отдают ответы клиентски, до сети.
 */

const CHANNEL = { id: 9, username: null, title: 'Рассылки', status: 'active', source: 'rusender', ig_connected: false };

const day = (offset: number) => new Date(Date.UTC(2026, 7, 20 + offset)).toISOString().slice(0, 10);

const summaryFor = (days: number) => ({
  days,
  from: day(0),
  to: day(5),
  // События окна: открытия/клики, СЛУЧИВШИЕСЯ в эти дни.
  events: { opens: 1234, clicks: 321 },
  // Итоги рассылок, ЗАПУЩЕННЫХ в окне, — другая величина, и это видно по числам.
  campaigns: {
    campaigns: 3, total: 9000, delivered: 8700, opens: 4100, clicks: 900,
    errors: 12, unsubscribes: 7, complaints: 1,
  },
  contacts: {
    day: day(5), contacts_total: 15000, contacts_active: 14200,
    contacts_unsubscribed: 600, contacts_unavailable: 200,
  },
  series: Array.from({ length: 6 }, (_, i) => ({
    day: day(i),
    opens: 150 + i * 20,
    clicks: 40 + i * 5,
    // Дыра в снимке базы — НЕ ноль: линия обязана разорваться, а не упасть.
    contacts_total: i === 3 ? null : 15000 - i * 10,
    contacts_active: i === 3 ? null : 14200 - i * 10,
    contacts_unsubscribed: i === 3 ? null : 600 + i,
  })),
  bounds: { first_day: day(0), last_day: day(5), campaigns: 3 },
});

const CAMPAIGNS = {
  days: 30,
  from: day(0),
  to: day(5),
  campaigns: [
    {
      campaign_id: 11, name: 'Августовская подборка', subject: 'Что нового',
      type: 'regular', status: 'completed', sender_email: 'sender@notem.ru',
      list_names: ['Основная база'], is_archived: false,
      started_at: `${day(1)}T09:00:00Z`, finished_at: `${day(1)}T10:00:00Z`,
      parts_count: 0, family_role: null,
      total: 5000, delivered: 4900, opens: 2400, clicks: 510,
      errors: 8, unsubscribes: 4, complaints: 0,
    },
    {
      campaign_id: 22, name: 'Возврат неактивных', subject: 'Мы скучали',
      type: 'regular', status: 'completed', sender_email: 'sender@notem.ru',
      list_names: ['Неактивные'], is_archived: false,
      started_at: `${day(3)}T09:00:00Z`, finished_at: `${day(3)}T10:00:00Z`,
      parts_count: 0, family_role: null,
      total: 4000, delivered: 3800, opens: 1700, clicks: 390,
      errors: 4, unsubscribes: 3, complaints: 1,
    },
  ],
};

async function bootRusender(
  page: Page,
  path: string,
  { surfaces = true, connected = true, empty = false } = {},
) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname === '/api/auth/me') {
      return json({ uid: 42, email: 'owner@pulse.local', role: 'user', avatar: null, rusender_surfaces: surfaces });
    }
    if (url.pathname === '/api/channels' && request.method() === 'GET') {
      return json({ enabled: true, channels: [CHANNEL] });
    }
    if (url.pathname === '/api/rusender/status') {
      return json({
        connected, channel_id: connected ? 9 : null,
        account_email: connected ? 'sender@notem.ru' : null,
        account_id: connected ? '777' : null,
        scopes: ['campaigns'], missing_scopes: [], connected_at: connected ? `${day(0)}T10:00:00Z` : null,
      });
    }
    if (url.pathname === '/api/rusender/summary') {
      const days = Number(url.searchParams.get('days') ?? 30);
      if (empty) {
        return json({
          days, from: null, to: null,
          events: { opens: 0, clicks: 0 },
          campaigns: { campaigns: 0, total: 0, delivered: 0, opens: 0, clicks: 0, errors: 0, unsubscribes: 0, complaints: 0 },
          contacts: null, series: [], bounds: { first_day: null, last_day: null, campaigns: 0 },
        });
      }
      return json(summaryFor(days));
    }
    if (url.pathname === '/api/rusender/campaigns') return json(empty ? { ...CAMPAIGNS, campaigns: [] } : CAMPAIGNS);
    if (url.pathname === '/api/prefs') return json({});
    if (url.pathname === '/api/tg/qr/status') return json({ connected: false, server_ready: false });
    if (url.pathname === '/api/ig/oauth/status') {
      return json({ connected: false, server_ready: false, env_fallback: false, token_state: 'none' });
    }
    if (url.pathname.startsWith('/api/rusender/')) return json({});
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_stubbed"}' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '9');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto(path);
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
}

test.beforeEach(async ({ browserName: _b }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Rusender — desktop-first поверхность');
});

test('Обзор: события окна и итоги рассылок — разные числа, не сложенные в одно', async ({ page }) => {
  await bootRusender(page, '/rusender');

  const body = page.locator('main');
  // Ждём НАСТОЯЩЕЕ число с разделителем разрядов: одиночные цифры есть уже у пилюль периода
  // («7д/30д/90д»), и ожидание /\d/ проходило до загрузки данных.
  await expect(body).toContainText(/\d[\s  ]?\d{3}/, { timeout: 20_000 });
  const text = (await body.innerText()).replace(/[  ]/g, ' ');

  // Открытия ОКНА (1 234) и открытия ЗАПУЩЕННЫХ рассылок (4 100) — обе величины на экране и
  // ни одна не подменена суммой 5 334: складывать их нельзя, и экран этого не делает.
  expect(text).toMatch(/1 ?234/);
  expect(text).toMatch(/4 ?1\d\d/);
  expect(text).not.toMatch(/5 ?334/);
});

test('Обзор: пустое окно говорит о пустоте, а не рисует нули как данные', async ({ page }) => {
  await bootRusender(page, '/rusender', { empty: true });
  await expect(page.locator('main')).toBeVisible();
  // Ни одна карточка не должна показывать «сломалось» — пустой архив это штатное состояние.
  await expect(page.getByText(/Не удалось|Ошибка/)).toHaveCount(0);
});

test('«Рассылки» и «База» скрыты без фичефлага и появляются с ним', async ({ page }) => {
  await bootRusender(page, '/rusender', { surfaces: false });
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Обзор' }).first()).toBeVisible({ timeout: 15_000 });
  await expect(nav.getByRole('link', { name: 'Рассылки' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'База' })).toHaveCount(0);

  await bootRusender(page, '/rusender', { surfaces: true });
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Рассылки' })).toBeVisible({ timeout: 15_000 });
});

test('«Рассылки»: список несёт имя, доставку и открытия каждой рассылки', async ({ page }) => {
  await bootRusender(page, '/rusender/campaigns');
  const body = page.locator('main');
  await expect(body).toContainText('Августовская подборка', { timeout: 20_000 });
  await expect(body).toContainText('Возврат неактивных');
  const text = (await body.innerText()).replace(/[  ]/g, ' ');
  expect(text).toMatch(/4 ?900/);   // доставлено первой рассылки
  expect(text).toMatch(/2 ?400/);   // её открытия
});

test('смена окна перезапрашивает обзор с новым числом дней', async ({ page }) => {
  await bootRusender(page, '/rusender');
  // Наблюдатель регистрируется ПОСЛЕ стенда: Playwright матчит роуты LIFO, и зарегистрированный
  // раньше catch-all перехватил бы запрос первым — счётчик остался бы пустым.
  const asked: number[] = [];
  await page.route(/\/api\/rusender\/summary/, async (route) => {
    asked.push(Number(new URL(route.request().url()).searchParams.get('days') ?? 0));
    await route.fallback();
  });
  await expect(page.locator('main')).toContainText(/\d[\s  ]?\d{3}/, { timeout: 20_000 });

  const period = page.getByRole('group', { name: 'Период' });
  await expect(period).toBeVisible();
  await period.getByRole('button', { name: '7д' }).click();
  await expect.poll(() => asked.includes(7), { timeout: 10_000 }).toBe(true);
});
