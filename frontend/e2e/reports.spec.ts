import { expect, test, type Page } from '@playwright/test';
import { selectPill } from './helpers';

/**
 * Отчёты — desktop-редизайн + mobile-инвариант. Демо-режим блокирует записи, поэтому поднимаем
 * «авторизованную» сессию и мокируем /api/* одним stateful-роутом (отчёты живут в замыкании теста,
 * как настоящая БД). Проверяем: (1) desktop-список — summary-таблица / поиск / фильтр / диалог
 * создания с телом POST → переход; (2) desktop-документ — read-режим без editor-chrome, Edit →
 * правка → Cancel без PUT, Edit → Save ровно один PUT и выход в read; (3) mobile — прежняя
 * inline-поверхность остаётся, новый desktop-chrome не появляется.
 */

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

interface MockReport {
  id: number;
  name: string;
  config: Record<string, unknown>;
  schedule: string;
  last_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BootState {
  postCount: number;
  putCount: number;
  lastCreateBody: Record<string, unknown> | null;
}

async function bootReports(page: Page, seed: MockReport[]): Promise<BootState> {
  const reports = [...seed];
  let nextId = Math.max(0, ...reports.map((r) => r.id)) + 1;
  const state: BootState = { postCount: 0, putCount: 0, lastCreateBody: null };

  const summary = (r: MockReport) => {
    const cfg = r.config ?? {};
    return {
      id: r.id,
      name: r.name,
      schedule: r.schedule,
      channel_id: typeof cfg.channelId === 'number' ? cfg.channelId : null,
      period_days: typeof cfg.periodDays === 'number' ? cfg.periodDays : null,
      block_count: Array.isArray(cfg.blocks) ? (cfg.blocks as unknown[]).length : null,
      last_sent_at: r.last_sent_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  };

  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/auth/me') return json(200, { uid: 11, email: 'e2e@test.local', role: 'user', avatar: null });
    if (path === '/api/channels') {
      return json(200, {
        enabled: true,
        channels: [
          { id: 1, username: 'testchan', title: 'Тестовый канал', status: 'active', source: 'collector', ig_connected: false },
          { id: 2, username: 'igonly', title: 'Только Instagram', status: 'active', source: 'ig', ig_connected: true },
          { id: 3, username: 'secondtg', title: 'Второй Telegram', status: 'active', source: 'collector', ig_connected: false },
        ],
        selected: 1,
      });
    }
    if (path === '/api/tg/full') {
      if (req.headers()['x-channel-id'] === '2') return json(400, { error: 'Источник не поддерживает Telegram' });
      const posts = Array.from({ length: 30 }, (_, i) => {
        const views = 2800 + i * 46 + Math.round(Math.sin(i / 2.4) * 420);
        return {
          id: i + 1,
          date: iso((29 - i) * DAY),
          views,
          reactions: Math.round(views * 0.052),
          forwards: Math.round(views * 0.012),
          replies: Math.round(views * 0.006),
          media_type: i % 3 === 0 ? 'photo' : 'text',
          caption: `Пост ${i + 1}`,
        };
      });
      return json(200, {
        channel: { title: 'Тестовый канал', username: 'testchan', memberCount: 1200 },
        views_summary: null,
        posts,
        mtproto_available: true,
        source: 'db',
      });
    }
    if (path === '/api/history/channel') {
      const rows = Array.from({ length: 30 }, (_, i) => ({
        day: new Date(Date.now() - (29 - i) * DAY).toISOString().slice(0, 10),
        subscribers: 1080 + i * 4,
        joins: 12 + (i % 5),
        leaves: 5 + (i % 3),
        views: 2800 + i * 46 + Math.round(Math.sin(i / 2.4) * 420),
        reactions: 120 + i * 3,
        forwards: 24 + (i % 8),
      }));
      return json(200, { enabled: true, rows });
    }
    if (path.startsWith('/api/tg/')) return json(200, {});
    if (path === '/api/prefs') return json(200, method === 'GET' ? {} : { ok: true });

    // ── Отчёты: stateful CRUD ──
    if (path === '/api/reports' && method === 'GET') return json(200, { reports: reports.map(summary) });
    if (path === '/api/reports' && method === 'POST') {
      state.postCount += 1;
      const body = req.postDataJSON() as { name: string; config?: Record<string, unknown>; schedule?: string };
      state.lastCreateBody = body;
      const r: MockReport = {
        id: nextId++,
        name: body.name,
        config: body.config ?? {},
        schedule: body.schedule ?? 'none',
        last_sent_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      reports.push(r);
      return json(200, { report: r });
    }

    const m = path.match(/^\/api\/reports\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const report = reports.find((r) => r.id === id);
      if (!report) return json(404, { error: 'Отчёт не найден' });
      if (method === 'GET') return json(200, { report });
      if (method === 'PUT') {
        state.putCount += 1;
        const patch = req.postDataJSON() as Partial<MockReport>;
        if (patch.name !== undefined) report.name = patch.name;
        if (patch.config !== undefined) report.config = patch.config as Record<string, unknown>;
        if (patch.schedule !== undefined) report.schedule = patch.schedule as string;
        report.updated_at = new Date().toISOString();
        return json(200, { report });
      }
      if (method === 'DELETE') {
        reports.splice(reports.indexOf(report), 1);
        return json(200, { ok: true });
      }
    }

    return json(404, { error: 'not_mocked' });
  });

  await page.addInitScript(() => {
    localStorage.setItem('pulse_token', 'e2e-token');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('pulse_channel', '1');
    if (!localStorage.getItem('pulse_theme')) localStorage.setItem('pulse_theme', 'dark');
  });

  return state;
}

const textReport = (): MockReport => ({
  id: 1,
  name: 'Итоги недели',
  config: { blocks: [{ id: 't1', type: 'text', config: { text: 'Первый черновик' } }], periodDays: 30, channelId: 1 },
  schedule: 'none',
  last_sent_at: null,
  created_at: iso(DAY),
  updated_at: iso(DAY),
});

test.describe('Отчёты — desktop', () => {
  test('список: summary-таблица, поиск, фильтр + диалог создания → переход', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-поверхность (таблица + диалог)');
    const state = await bootReports(page, [
      { id: 1, name: 'Недельный обзор', config: { blocks: [1, 2, 3, 4], periodDays: 7, channelId: 1 }, schedule: 'weekly', last_sent_at: null, created_at: iso(3 * DAY), updated_at: iso(1 * DAY) },
      { id: 2, name: 'Рост', config: { blocks: [1, 2], periodDays: 30, channelId: 1 }, schedule: 'none', last_sent_at: null, created_at: iso(4 * DAY), updated_at: iso(2 * DAY) },
      { id: 3, name: 'Контент план', config: {}, schedule: 'monthly', last_sent_at: null, created_at: iso(5 * DAY), updated_at: iso(3 * DAY) },
    ]);

    await page.goto('/reports');
    await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });

    // Нет постоянной витрины шаблонов на главной странице списка.
    await expect(page.getByText('Начать с шаблона')).toHaveCount(0);

    // Плотная таблица с summary-полями.
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(3);
    const weekly = page.getByRole('row', { name: /Недельный обзор/ });
    await expect(weekly).toContainText('@testchan');
    await expect(weekly).toContainText('7д');
    await expect(weekly).toContainText('4');
    await expect(weekly).toContainText('Раз в неделю');
    // Legacy-строка без channelId/periodDays/blocks — честные фолбэки.
    const legacy = page.getByRole('row', { name: /Контент план/ });
    await expect(legacy).toContainText('Текущий источник');
    await expect(legacy).toContainText('30д');
    await expect(legacy).toContainText('Базовый набор');

    // Поиск.
    await page.getByLabel('Поиск отчётов').fill('рост');
    await expect(page.locator('table tbody tr')).toHaveCount(1);
    await page.getByLabel('Поиск отчётов').fill('');

    // Фильтр «С доставкой» — только weekly/monthly.
    await page.getByRole('button', { name: 'С доставкой' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(2);
    await page.getByRole('button', { name: 'Все' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(3);

    const listShot = testInfo.outputPath('reports-list-desktop.png');
    await page.screenshot({ path: listShot, fullPage: true });
    await testInfo.attach('reports-list-dark-desktop', { path: listShot, contentType: 'image/png' });

    const listOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(listOverflow).toBe(false);

    // ── Диалог создания: имя / шаблон «Пустой» / период / доставка → один POST → переход ──
    await page.getByRole('button', { name: 'Создать отчёт' }).click();
    const dialog = page.getByRole('dialog', { name: 'Новый отчёт' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Источник · Telegram').locator('option[value="2"]')).toHaveCount(0);
    await dialog.getByLabel('Название').fill('Новый тест');
    await dialog.getByRole('radio', { name: /Пустой/ }).click();
    await dialog.getByRole('button', { name: '90д' }).click();
    await selectPill(dialog.getByLabel('Доставка на почту'), { value: 'weekly' });
    await dialog.getByRole('button', { name: 'Создать отчёт' }).click();

    // Переход в новый отчёт.
    await expect(page).toHaveURL(/\/reports\/4$/);
    await expect(page.getByRole('heading', { name: 'Новый тест' })).toBeVisible();
    await expect(page.getByText('В этом отчёте пока нет блоков')).toBeVisible();

    // Тело POST: name / channelId / periodDays / blocks / schedule.
    const body = state.lastCreateBody as { name: string; schedule: string; config: { blocks: unknown[]; periodDays: number; channelId: number } };
    expect(body.name).toBe('Новый тест');
    expect(body.schedule).toBe('weekly');
    expect(body.config.channelId).toBe(1);
    expect(body.config.periodDays).toBe(90);
    expect(Array.isArray(body.config.blocks)).toBe(true);
    expect(body.config.blocks.length).toBe(0);
    expect(state.postCount).toBe(1);
  });

  test('документ: read без editor-chrome; Edit→Cancel без PUT; Edit→Save ровно один PUT', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'desktop read/edit документ');
    const state = await bootReports(page, [textReport()]);

    await page.goto('/reports/1');
    await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });

    // Read-режим: рабочий документ, без inline-editor.
    await expect(page.getByRole('heading', { name: 'Итоги недели' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Редактировать' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Печать / PDF' })).toBeVisible();
    await expect(page.getByText('Первый черновик')).toBeVisible();
    await expect(page.locator('textarea')).toHaveCount(0);
    await expect(page.getByLabel('Добавить блок')).toHaveCount(0);

    const readShot = testInfo.outputPath('report-read-desktop.png');
    await page.screenshot({ path: readShot, fullPage: true });
    await testInfo.attach('report-read-dark-desktop', { path: readShot, contentType: 'image/png' });

    // Edit → правка → Cancel: возврат к сохранённому, ни одного PUT.
    await page.getByRole('button', { name: 'Редактировать' }).click();
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();
    await textarea.fill('Черновик изменён но отменён');
    await page.getByRole('button', { name: 'Отмена' }).click();
    await expect(page.getByRole('button', { name: 'Редактировать' })).toBeVisible();
    await expect(page.locator('textarea')).toHaveCount(0);
    await expect(page.getByText('Первый черновик')).toBeVisible();
    expect(state.putCount).toBe(0);

    // Edit → правка → Save: ровно один PUT, выход в read с новым содержимым.
    await page.getByRole('button', { name: 'Редактировать' }).click();
    await page.locator('textarea').fill('Финальный текст');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('button', { name: 'Редактировать' })).toBeVisible();
    await expect(page.locator('textarea')).toHaveCount(0);
    await expect(page.getByText('Финальный текст')).toBeVisible();
    expect(state.putCount).toBe(1);

    // Печатная поверхность оставляет документ и скрывает навигацию/editor chrome.
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('heading', { name: 'Итоги недели' })).toBeVisible();
    await expect(page.getByText('Финальный текст')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Редактировать' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Печать / PDF' })).not.toBeVisible();
    await expect(page.getByRole('navigation')).not.toBeVisible();
    await page.emulateMedia({ media: 'screen' });

    // Нет горизонтального overflow на 1440.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
  });

  test('сломанный IG-only source не запирает документ: Edit переводит на доступный Telegram-источник', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'desktop recovery path');
    const broken = textReport();
    broken.id = 2;
    broken.name = 'Старый отчёт';
    broken.config = { ...broken.config, channelId: 2 };
    const state = await bootReports(page, [broken]);

    await page.goto('/reports/2');
    await expect(page.getByText('Не удалось построить отчёт')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Редактировать' })).toBeVisible();

    await page.getByRole('button', { name: 'Редактировать' }).click();
    await expect(page.getByLabel('Источник · Telegram')).toHaveAttribute('data-value', '1');
    await page.getByRole('button', { name: 'Сохранить' }).click();

    await expect(page.getByRole('button', { name: 'Редактировать' })).toBeVisible();
    await expect(page.getByText('Первый черновик')).toBeVisible();
    expect(state.putCount).toBe(1);
  });

  test('drill-down открывает метрику на закреплённом Telegram-источнике отчёта', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'desktop pinned-source drill-down');
    const report = textReport();
    report.id = 3;
    report.name = 'Отчёт второго канала';
    report.config = {
      blocks: [
        'metric-views',
        'metric-subscribers',
        'metric-reactions',
        { id: 'line-views', type: 'chart', config: { metric: 'views', viz: 'line' } },
        { id: 'bar-views', type: 'chart', config: { metric: 'views', viz: 'bar' } },
      ],
      periodDays: 30,
      channelId: 3,
    };
    await bootReports(page, [report]);
    await page.addInitScript(() => {
      localStorage.setItem('pulse_network', 'ig');
      localStorage.setItem('pulse_channel', '1');
    });

    await page.goto('/reports/3');
    await expect(page.getByRole('heading', { name: 'Отчёт второго канала' })).toBeVisible();
    const referenceCharts = page.locator('svg[data-chart-kind="line"][data-chart-appearance="rhea"]');
    await expect(referenceCharts).toHaveCount(4);
    const referenceChart = referenceCharts.first();
    await expect(referenceChart).toBeVisible();
    await expect(page.locator('svg[data-chart-kind="bar"]')).toHaveCount(1);
    await expect(page.locator('svg[data-chart-kind="bar"][data-chart-appearance="rhea"]')).toHaveCount(0);
    const chartBox = await referenceChart.boundingBox();
    expect(chartBox).not.toBeNull();
    await page.mouse.move(chartBox!.x + chartBox!.width * 0.62, chartBox!.y + chartBox!.height * 0.45);
    const referenceTooltip = page.locator('[data-chart-tooltip-appearance="rhea"]');
    await expect(referenceTooltip).toBeVisible();
    await expect(referenceTooltip).toContainText('Просмотры');
    const drillLink = page.locator('[data-report-chart-label="Просмотры"]').getByRole('link', { name: 'Открыть →' });
    await expect(drillLink).toBeVisible();
    const metricShot = testInfo.outputPath('report-metric-desktop.png');
    await page.screenshot({ path: metricShot, fullPage: true });
    await testInfo.attach('report-metric-dark-desktop', { path: metricShot, contentType: 'image/png' });

    await page.evaluate(() => localStorage.setItem('pulse_theme', 'light'));
    await page.reload();
    await expect(referenceChart).toBeVisible();
    const lightChartBox = await referenceChart.boundingBox();
    expect(lightChartBox).not.toBeNull();
    await page.mouse.move(lightChartBox!.x + lightChartBox!.width * 0.62, lightChartBox!.y + lightChartBox!.height * 0.45);
    await expect(referenceTooltip).toBeVisible();
    const metricLightShot = testInfo.outputPath('report-metric-light-desktop.png');
    await page.screenshot({ path: metricLightShot, fullPage: true });
    await testInfo.attach('report-metric-light-desktop', { path: metricLightShot, contentType: 'image/png' });

    await drillLink.click();
    await expect(page).toHaveURL(/\/metrics\/views/);

    const sourceState = await page.evaluate(() => ({
      network: localStorage.getItem('pulse_network'),
      channel: localStorage.getItem('pulse_channel'),
      remembered: JSON.parse(localStorage.getItem('pulse_source_channels') ?? '{}') as Record<string, number>,
    }));
    expect(sourceState.network).toBe('tg');
    expect(sourceState.channel).toBe('3');
    expect(sourceState.remembered.tg).toBe(3);
  });
});

test.describe('Отчёты — mobile-инвариант', () => {
  test('mobile сохраняет прежнюю поверхность; desktop-chrome не появляется', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-430', 'mobile-инвариант (430px)');
    await bootReports(page, [textReport()]);

    await page.goto('/reports');
    await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });

    // Прежняя mobile-поверхность: витрина шаблонов и мгновенное создание.
    await expect(page.getByText('Начать с шаблона')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Создать отчёт' })).toBeVisible();
    // Нового desktop-поиска / фильтра нет.
    await expect(page.getByLabel('Поиск отчётов')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'С доставкой' })).toHaveCount(0);

    // Документ на мобильном — прежняя всегда-inline поверхность (textarea + «+»), без read-chrome.
    await page.goto('/reports/1');
    await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.getByLabel('Добавить блок').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Редактировать' })).toHaveCount(0);
    await page.getByLabel('Добавить блок').first().click({ force: true });
    await expect(page.getByText('Карта', { exact: true })).toBeVisible();
  });
});
