import { expect, test, type Page } from '@playwright/test';

// «Загрузки» СДЭКа — источник БЕЗ API, поэтому спека идёт не через демо-режим (он read-only и
// блокирует запись), а через полный перехват /api/ с собственными стабами: только так проверяется
// главное — что после загрузки файла пользователь ВИДИТ, что именно попало в базу.

const IMPORT = {
  id: 7,
  filename: 'orders_export_WxFEw8c.xlsx',
  status: 'done',
  rows_total: 1126,
  rows_inserted: 1120,
  rows_updated: 4,
  rows_rejected: 2,
  rows_deleted: 0,
  orders_total: 1100,
  period_from: '2025-07-31',
  period_to: '2026-07-30',
  warnings: ['Незнакомые службы доставки: Почта России'],
  rejected: [{ row: 12, order_id: '33896248', reason: 'нет товара' }],
  error: null,
  created_at: '2026-08-24T10:15:00',
  finished_at: '2026-08-24T10:15:01',
};

/** Календарь: месяц залитых дней с выручкой, затем неделя дыры — ровно то различие, ради
    которого карточка существует. */
function coverageDays() {
  const days: Array<{ day: string; revenue: number; orders: number; covered: boolean }> = [];
  const start = new Date(Date.UTC(2026, 6, 1));
  for (let i = 0; i < 40; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const day = d.toISOString().slice(0, 10);
    const covered = i < 30;
    days.push({ day, revenue: covered ? (i % 7 === 0 ? 0 : 1000 + i * 250) : 0, orders: covered ? i % 4 : 0, covered });
  }
  return days;
}

async function bootCdek(page: Page, opts: { imports?: unknown[]; uploadStatus?: number } = {}) {
  const uploads: string[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/auth/me') return json(200, { uid: 11, email: 'cdek@test.local', role: 'user', avatar: null });
    if (path === '/api/channels') {
      return json(200, {
        enabled: true,
        channels: [{ id: 5, username: null, title: 'Склад Москва', status: 'active', source: 'cdek' }],
        selected: 5,
      });
    }
    if (path === '/api/prefs') return json(200, request.method() === 'GET' ? {} : { ok: true });
    if (path === '/api/cdek/status') {
      return json(200, {
        channel_id: 5,
        title: 'Склад Москва',
        warehouse_code: '19821',
        tz: 'Europe/Moscow',
        last_import: null,
      });
    }
    if (path === '/api/cdek/imports') return json(200, { imports: opts.imports ?? [] });
    if (path === '/api/cdek/coverage') {
      return json(200, {
        from: '2026-07-01',
        to: '2026-08-09',
        bounds: { first_day: '2026-07-01', last_day: '2026-08-09', orders: 1100 },
        days: coverageDays(),
      });
    }
    if (path === '/api/cdek/import' && request.method() === 'POST') {
      uploads.push(String(request.headers()['x-filename'] ?? ''));
      if (opts.uploadStatus && opts.uploadStatus !== 200) {
        return json(opts.uploadStatus, { error: 'Это не .xlsx — внутри нет zip-архива' });
      }
      return json(200, { ok: true, duplicate: false, import: IMPORT });
    }
    return json(404, { error: 'not_stubbed' });
  });

  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '5');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto('/cdek');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  return uploads;
}

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'СДЭК — desktop-first поверхность');
});

test('источник СДЭК ведёт на «Загрузки» с дропзоной, покрытием и историей', async ({ page }) => {
  await bootCdek(page);

  await expect(page.getByText('Перетащите файл выгрузки сюда')).toBeVisible();
  await expect(page.getByText(/Склад 19821/)).toBeVisible();
  // Разные «пусто» календаря обязаны быть подписаны: иначе дыра в загрузке читается как ноль.
  await expect(page.getByText('выгрузки нет')).toBeVisible();
  await expect(page.getByText('0 заказов')).toBeVisible();
  await expect(page.getByText('Выгрузок пока нет')).toBeVisible();
});

test('после загрузки виден отчёт: что принято, что обновлено, что отклонено', async ({ page }) => {
  const uploads = await bootCdek(page);

  await page.locator('input[type=file]').setInputFiles({
    name: 'orders_export_WxFEw8c.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('PK фиктивный zip'),
  });

  const report = page.locator('main');
  await expect(report.getByText('Выгрузка загружена').first()).toBeVisible();
  await expect(report.getByText('1 126')).toBeVisible();
  await expect(report.getByText('1 100')).toBeVisible();
  await expect(report.getByText('1 120')).toBeVisible();
  await expect(report.getByRole('link', { name: 'Скачать отклонённые строки' })).toBeVisible();
  await expect(report.getByText(/Период файла: 31 июл\..*30 июл\./)).toBeVisible();
  // Предупреждение импорта не прячется в тост: оно живёт на странице рядом с отчётом.
  await expect(report.getByText(/Незнакомые службы доставки/)).toBeVisible();
  // Имя файла едет заголовком percent-encoded — иначе кириллица порвала бы HTTP-заголовок.
  expect(uploads).toHaveLength(1);
  expect(decodeURIComponent(uploads[0])).toBe('orders_export_WxFEw8c.xlsx');
});

test('нечитаемый файл объясняет причину, а не «что-то пошло не так»', async ({ page }) => {
  await bootCdek(page, { uploadStatus: 422 });

  await page.locator('input[type=file]').setInputFiles({
    name: 'заметки.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('это не выгрузка'),
  });

  await expect(page.getByRole('alert')).toContainText('Это не .xlsx');
});

test('история загрузок показывает результат каждого файла', async ({ page }) => {
  await bootCdek(page, { imports: [IMPORT, { ...IMPORT, id: 8, filename: 'битый.xlsx', status: 'error', error: 'Это не .xlsx', rows_total: 0, rows_inserted: 0, rows_updated: 0, rows_rejected: 0, orders_total: 0 }] });

  const row = page.getByRole('row', { name: /orders_export_WxFEw8c\.xlsx/ });
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: 'отклонённые' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'пересобрать' })).toBeVisible();
  // У упавшего импорта нет ни файла, ни смысла пересобирать — только причина.
  const failed = page.getByRole('row', { name: /битый\.xlsx/ });
  await expect(failed).toContainText('Это не .xlsx');
  await expect(failed.getByRole('button', { name: 'пересобрать' })).toHaveCount(0);
});
