import type { Locator, Page } from '@playwright/test';

// The only authenticated endpoint demo fixtures do NOT cover — stub it so the authed shell renders
// offline. Shape matches MeSchema (all fields optional + passthrough), so this parses fine.
const DEMO_ME = { uid: 999, email: 'demo@pulse.local', role: 'user', avatar: null };
const DAY_MS = 86_400_000;

const igDays = Array.from({ length: 60 }, (_, index) =>
  new Date(Date.now() - (59 - index) * DAY_MS).toISOString(),
);

function igMetric(name: string, valueAt: (index: number) => number) {
  return {
    name,
    period: 'day',
    values: igDays.map((end_time, index) => ({ end_time, value: valueAt(index) })),
  };
}

function demoIgPayload(path: string): unknown | undefined {
  if (path === '/api/ig/profile') {
    return { mock: true, username: 'demo_channel', name: 'Demo Instagram', followers_count: 12_840, synced_at: Date.now() };
  }
  if (path === '/api/ig/insights') {
    const wave = (index: number, size: number) => ((index % 7) - 3) * size;
    return {
      mock: true,
      data: [
        igMetric('reach', (i) => 2_900 + i * 18 + wave(i, 85)),
        igMetric('views', (i) => 4_800 + i * 24 + wave(i, 120)),
        igMetric('total_interactions', (i) => 250 + i * 2 + wave(i, 8)),
        igMetric('likes', (i) => 172 + i + wave(i, 5)),
        igMetric('saves', (i) => 36 + Math.floor(i / 5) + wave(i, 1)),
        igMetric('comments', (i) => 18 + Math.floor(i / 8) + Math.abs(wave(i, 1))),
        igMetric('shares', (i) => 24 + Math.floor(i / 6) + Math.abs(wave(i, 1))),
        igMetric('follows', (i) => 27 + Math.floor(i / 10) + Math.abs(wave(i, 1))),
        igMetric('unfollows', (i) => 11 + Math.abs(wave(i, 1))),
        igMetric('follower_count', (i) => 12_300 + i * 9),
      ],
    };
  }
  if (path === '/api/ig/posts') {
    return {
      mock: true,
      data: Array.from({ length: 8 }, (_, index) => ({
        id: `demo-ig-${index + 1}`,
        timestamp: new Date(Date.now() - (index + 1) * DAY_MS).toISOString(),
        media_type: index % 3 === 0 ? 'VIDEO' : 'IMAGE',
        media_product_type: index % 3 === 0 ? 'REELS' : 'FEED',
        reach: 4_900 - index * 280,
        views: 7_200 - index * 310,
        like_count: 260 - index * 14,
        comments_count: 31 - index,
        saved: 58 - index * 3,
        shares: 37 - index * 2,
        total_interactions: 386 - index * 20,
        caption: `Demo publication ${index + 1}`,
      })),
    };
  }
  if (path === '/api/ig/breakdowns') return { mock: true, data: [] };
  if (path === '/api/ig/online') return { mock: true, data: [] };
  if (path === '/api/ig/stories') return { mock: true, data: [] };
  if (path === '/api/ig/tags') return { mock: true, data: [] };
  if (path === '/api/ig/oauth/status') return { connected: true, server_ready: true, env_fallback: false };
  return undefined;
}

const MS_CHANNELS = [
  { id: '16f07379-8039-11ec-0a80-03970021e97d', name: 'Интернет-магазин', type: 'ECOMMERCE', orders: 48, sum: 428_000 },
  { id: '26f07379-8039-11ec-0a80-03970021e97e', name: 'Партнёры', type: 'DIRECT_SALES', orders: 17, sum: 206_000 },
  { id: '36f07379-8039-11ec-0a80-03970021e97f', name: 'Розница', type: 'OTHER', orders: 31, sum: 159_000 },
];

/** Deterministic assortment comparison (compare=prev) for the «Динамика» tab. Values are already in
    the metric natural unit (rub / count), previous-base-zero rows carry deltaPct=null. */
function demoMsComparison() {
  return {
    available: true,
    partial: false,
    identity_fallback_count: 0,
    current: { from: '2026-06-01', to: '2026-06-30' },
    previous: { from: '2026-05-02', to: '2026-05-31' },
    counts: { current_only: 1, previous_only: 1, both: 2 },
    metrics: {
      revenue: {
        unit: 'rub',
        gainers: [{ name: 'Товар A', current: 240_000, previous: 120_000, delta: 120_000, deltaPct: 100 }],
        losers: [{ name: 'Товар C', current: 90_000, previous: 180_000, delta: -90_000, deltaPct: -50 }],
        appeared: [{ name: 'Товар D', current: 60_000, previous: 0, delta: 60_000, deltaPct: null }],
        disappeared: [{ name: 'Товар Z', current: 0, previous: 40_000, delta: -40_000, deltaPct: -100 }],
      },
      profit: {
        unit: 'rub',
        gainers: [{ name: 'Товар B', current: 80_000, previous: 50_000, delta: 30_000, deltaPct: 60 }],
        losers: [{ name: 'Товар C', current: -5_000, previous: 20_000, delta: -25_000, deltaPct: -125 }],
        appeared: [{ name: 'Товар D', current: 12_000, previous: 0, delta: 12_000, deltaPct: null }],
        disappeared: [{ name: 'Товар Z', current: 0, previous: 9_000, delta: -9_000, deltaPct: -100 }],
      },
      units: {
        unit: 'count',
        gainers: [{ name: 'Товар A', current: 120, previous: 70, delta: 50, deltaPct: 71.4 }],
        losers: [{ name: 'Товар C', current: 60, previous: 90, delta: -30, deltaPct: -33.3 }],
        appeared: [{ name: 'Товар D', current: 18, previous: 0, delta: 18, deltaPct: null }],
        disappeared: [{ name: 'Товар Z', current: 0, previous: 14, delta: -14, deltaPct: -100 }],
      },
    },
    limit: 5,
  };
}

// Production-shaped MAXIMUM compact payloads for the three list cards that overflow their fixed
// 264px half-tile when a real tenant fills them (funnel statuses, top products, geography). Opt-in
// via `bootDemo(..., { msMax: true })`; every other spec keeps the small default slice below. Long
// Russian names + many rows + a non-empty aggregate/no-state/no-city tail reproduce the worst case.
const MS_MAX_FUNNEL_ROWS = [
  { state_id: 's1', name: 'Новый заказ (ожидает подтверждения)', color: '#4a90d9', orders: 214, sum: 3_120_000 },
  { state_id: 's2', name: 'Подтверждён менеджером', color: '#2e8b57', orders: 188, sum: 2_740_000 },
  { state_id: 's3', name: 'Собран на складе', color: '#f5a623', orders: 156, sum: 2_010_000 },
  { state_id: 's4', name: 'Передан в службу доставки', color: '#7b61ff', orders: 132, sum: 1_680_000 },
  { state_id: 's5', name: 'Доставлен покупателю', color: '#50b0a0', orders: 118, sum: 1_450_000 },
  { state_id: 's6', name: 'Возврат оформлен', color: '#c0504d', orders: 44, sum: 520_000 },
  { state_id: 's7', name: 'Отменён покупателем', color: '#9b59b6', orders: 31, sum: 340_000 },
  { state_id: 's8', name: 'Ожидает оплаты', color: '#e67e22', orders: 27, sum: 300_000 },
];

const MS_MAX_TOP_PRODUCTS = [
  { name: 'Кофемашина автоматическая De Longhi Magnifica S', quantity: 128, revenue: 3_120_000, profit: 640_000, margin: 20.5 },
  { name: 'Робот-пылесос Xiaomi Roborock S8 Pro Ultra', quantity: 96, revenue: 2_480_000, profit: 520_000, margin: 21.0 },
  { name: 'Смартфон Samsung Galaxy S24 Ultra 512 ГБ', quantity: 74, revenue: 2_010_000, profit: 310_000, margin: 15.4 },
  { name: 'Наушники Apple AirPods Pro 2-го поколения USB-C', quantity: 210, revenue: 1_680_000, profit: 420_000, margin: 25.0 },
  { name: 'Телевизор LG OLED evo C4 65 дюймов 4K', quantity: 38, revenue: 1_450_000, profit: 190_000, margin: 13.1 },
  { name: 'Игровая консоль Sony PlayStation 5 Slim', quantity: 52, revenue: 1_120_000, profit: 150_000, margin: 13.4 },
];

const MS_MAX_GEOGRAPHY = [
  { city: 'Москва', orders: 342, sum: 5_120_000 },
  { city: 'Санкт-Петербург', orders: 268, sum: 3_940_000 },
  { city: 'Екатеринбург', orders: 141, sum: 1_820_000 },
  { city: 'Новосибирск', orders: 118, sum: 1_460_000 },
  { city: 'Нижний Новгород', orders: 96, sum: 1_180_000 },
  { city: 'Ростов-на-Дону', orders: 84, sum: 1_020_000 },
  { city: 'Казань', orders: 73, sum: 910_000 },
  { city: 'Челябинск', orders: 61, sum: 760_000 },
];

/** Deterministic MoySklad slice used only by desktop browser tests. It mirrors the production
    contract closely enough to exercise aggregate filters, breakdown groups, ranking and explorer.
    `opts.max` swaps the three list-card payloads for their production-shaped maximum variants. */
function demoMsPayload(url: URL, opts: { max?: boolean } = {}): unknown | undefined {
  const path = url.pathname;
  const rawDays = url.searchParams.get('days');
  const days = rawDays === '0' ? 0 : Number(rawDays) || 30;
  if (path === '/api/ms/summary') {
    // Deterministic daily revenue/orders series over the requested window. `days=0` («Всё») spans
    // 90 days. A few zero-order days exercise the sparse-AOV path; the caption varies by window so
    // the explorer can prove it re-fetched the SELECTED period instead of reusing the top-bar one.
    const count = days === 0 ? 90 : days;
    const dayKeys = Array.from({ length: count }, (_, index) =>
      new Date(Date.now() - (count - index - 1) * DAY_MS).toISOString().slice(0, 10),
    );
    const orderRows = dayKeys.map((day, index) => {
      const orderCount = index % 6 === 0 ? 0 : 1 + ((index * 3) % 5);
      return { day, count: orderCount, sum: orderCount === 0 ? 0 : 3_800 + ((index * 137) % 6_200) };
    });
    const revenueRows = dayKeys.map((day, index) => ({ day, value: 3_600 + ((index * 151) % 5_400) }));
    return {
      revenue: { total: revenueRows.reduce((total, row) => total + row.value, 0), series: revenueRows },
      orders: {
        totalSum: orderRows.reduce((total, row) => total + row.sum, 0),
        totalCount: orderRows.reduce((total, row) => total + row.count, 0),
        series: orderRows,
      },
    };
  }
  if (path === '/api/ms/funnel') {
    if (opts.max) {
      const rows = MS_MAX_FUNNEL_ROWS;
      const noStateOrders = 18;
      return {
        window_days: days,
        total_orders: rows.reduce((total, row) => total + row.orders, 0) + noStateOrders,
        no_state_orders: noStateOrders,
        no_state_sum: 210_000,
        rows,
      };
    }
    return {
      window_days: days,
      total_orders: 96,
      no_state_orders: 4,
      no_state_sum: 24_000,
      rows: [
        { state_id: 's1', name: 'Новый', color: '#4a90d9', orders: 40, sum: 320_000 },
        { state_id: 's2', name: 'Выполнен', color: '#2e8b57', orders: 38, sum: 300_000 },
        { state_id: 's3', name: 'Отменён', color: '#c0504d', orders: 14, sum: 90_000 },
      ],
    };
  }
  if (path === '/api/ms/top-products') {
    const sort = url.searchParams.get('sort') ?? 'revenue';
    const limit = Number(url.searchParams.get('limit')) || 10;
    const rows: Array<{ name: string; quantity: number; revenue: number; profit: number; margin: number | null }> = opts.max
      ? [...MS_MAX_TOP_PRODUCTS]
      : [
          { name: 'Товар A', quantity: 120, revenue: 240_000, profit: 60_000, margin: 25 },
          { name: 'Товар B', quantity: 80, revenue: 160_000, profit: 80_000, margin: 50 },
          { name: 'Товар C', quantity: 60, revenue: 90_000, profit: -5_000, margin: -5.56 },
          { name: 'Товар без продаж', quantity: 0, revenue: 0, profit: 10_000, margin: null },
        ];
    const value = (row: (typeof rows)[number]) =>
      sort === 'profit' ? row.profit : sort === 'margin' ? row.margin : row.revenue;
    rows.sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av == null && bv != null) return 1;
      if (av != null && bv == null) return -1;
      return (bv ?? 0) - (av ?? 0) || a.name.localeCompare(b.name, 'ru');
    });
    const body: Record<string, unknown> = {
      rows: rows.slice(0, limit),
      total: rows.length,
      truncated: false,
      // Сводка концентрации считается сервером по полному отчёту (ниже — согласованные величины
      // для строк выше, в рублях): pos-выручка 240k+160k+90k, pos-прибыль 60k+80k+10k, убыток C 5k.
      summary: {
        complete: true,
        product_count: rows.length,
        top_n: 10,
        revenue_positive_total: 490_000,
        profit_positive_total: 150_000,
        revenue_top10_share_pct: 100,
        profit_top10_share_pct: 100,
        net_margin_pct: 29.6,
        loss_making_count: 1,
        loss_making_amount: 5_000,
      },
    };
    // Сравнение с предыдущим равным окном добавляется ТОЛЬКО при compare=prev (вкладка «Динамика»).
    if (url.searchParams.get('compare') === 'prev') {
      body.comparison = days === 0 ? { available: false, reason: 'all' } : demoMsComparison();
    }
    return body;
  }
  if (path === '/api/ms/customers') {
    const count = days === 0 ? 120 : days;
    const series = Array.from({ length: count }, (_, index) => {
      const day = new Date(Date.now() - (count - index - 1) * DAY_MS).toISOString().slice(0, 10);
      const newOrders = index % 4 === 0 ? 0 : 1 + (index % 3);
      const repeatOrders = index % 3 === 0 ? 2 : index % 5 === 0 ? 1 : 0;
      return {
        day,
        new_orders: newOrders,
        repeat_orders: repeatOrders,
        sum_new: newOrders * (4_000 + (index % 4) * 700),
        sum_repeat: repeatOrders * (7_000 + (index % 3) * 900),
      };
    });
    const ordersNew = series.reduce((sum, row) => sum + row.new_orders, 0);
    const ordersRepeat = series.reduce((sum, row) => sum + row.repeat_orders, 0);
    const sumNew = series.reduce((sum, row) => sum + row.sum_new, 0);
    const sumRepeat = series.reduce((sum, row) => sum + row.sum_repeat, 0);
    return {
      window_days: days,
      summary: {
        customers: 172,
        new_customers: 151,
        repeat_customers: 21,
        orders_new: ordersNew,
        orders_repeat: ordersRepeat,
        sum_new: sumNew,
        sum_repeat: sumRepeat,
        no_agent_orders: 3,
        repeat_ever: 37,
      },
      series,
    };
  }
  if (path === '/api/ms/rfm') {
    return {
      window_days: days,
      as_of: new Date().toISOString().slice(0, 10),
      customers: 100,
      no_agent_orders: 3,
      total_orders: 200,
      total_sum: 1_500_000,
      segments: [
        { key: 'champions', customers: 12, orders: 50, sum: 500_000, average_recency_days: 2, average_frequency: 4.2, average_monetary: 41_667 },
        { key: 'loyal', customers: 22, orders: 60, sum: 400_000, average_recency_days: 7, average_frequency: 2.7, average_monetary: 18_182 },
        { key: 'potential', customers: 25, orders: 35, sum: 250_000, average_recency_days: 12, average_frequency: 1.4, average_monetary: 10_000 },
        { key: 'new', customers: 20, orders: 20, sum: 100_000, average_recency_days: 3, average_frequency: 1, average_monetary: 5_000 },
        { key: 'at_risk', customers: 13, orders: 25, sum: 200_000, average_recency_days: 24, average_frequency: 1.9, average_monetary: 15_385 },
        { key: 'hibernating', customers: 8, orders: 10, sum: 50_000, average_recency_days: 28, average_frequency: 1.3, average_monetary: 6_250 },
      ],
    };
  }
  if (path === '/api/ms/top-customers') {
    return {
      window_days: days,
      rows: [
        { agent_id: 'a1', name: 'ООО «Покупатель»', orders: 4, sum: 120_000 },
        { agent_id: 'a2', name: 'ИП Клиент', orders: 2, sum: 64_000 },
      ],
    };
  }
  if (path === '/api/ms/cohorts') {
    // Детерминированные когорты за последние 4 месяца (относительно now, чтобы клетки были
    // «наступившими», а не будущими-пустыми). Клетка несёт active (клиентов с заказом) и revenue
    // (₽ выручки их заказов) — покрывает три режима полной страницы: возвращаемость/выручка/LTV.
    const cohortMonth = (monthsAgo: number) => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - monthsAgo);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };
    // size, затем по offset: [active, revenue]. Ретеншен спадает, выручка когорты тоже.
    const specs = [
      { monthsAgo: 3, size: 40, cells: [[40, 200_000], [22, 132_000], [14, 98_000], [9, 72_000]] },
      { monthsAgo: 2, size: 30, cells: [[30, 150_000], [16, 96_000], [10, 65_000]] },
      { monthsAgo: 1, size: 25, cells: [[25, 130_000], [12, 78_000]] },
      { monthsAgo: 0, size: 18, cells: [[18, 99_000]] },
    ];
    return {
      cohorts: specs.map((spec) => ({
        cohort_month: cohortMonth(spec.monthsAgo),
        size: spec.size,
        cells: spec.cells.map(([active, revenue], offset) => ({ offset, active, revenue })),
      })),
    };
  }
  if (path === '/api/ms/returns') {
    const count = days === 0 ? 90 : days;
    const series = Array.from({ length: count }, (_, index) => ({
      day: new Date(Date.now() - (count - index - 1) * DAY_MS).toISOString().slice(0, 10),
      // Детерминированный «редкий» ряд: возврат примерно раз в пять дней, сумма кратна индексу.
      count: index % 5 === 0 ? 1 : 0,
      sum: index % 5 === 0 ? 7_000 : 0,
    }));
    return {
      window_days: days,
      archive_status: 'done',
      complete: true,
      archived_count: 18,
      total_estimate: 18,
      count: series.reduce((total, row) => total + row.count, 0),
      sum: series.reduce((total, row) => total + row.sum, 0),
      series,
    };
  }
  if (path === '/api/ms/sales-by-channel') {
    return {
      window_days: days,
      total_orders: MS_CHANNELS.reduce((total, row) => total + row.orders, 0) + 4,
      no_channel_orders: 4,
      no_channel_sum: 8_500,
      rows: MS_CHANNELS.map(({ id, ...row }) => ({ sales_channel_id: id, ...row })),
    };
  }
  if (path === '/api/ms/geography') {
    if (opts.max) {
      const rows = MS_MAX_GEOGRAPHY;
      const noCity = 47;
      return {
        window_days: days,
        total_orders: rows.reduce((total, row) => total + row.orders, 0) + noCity,
        no_city_orders: noCity,
        rows,
      };
    }
    return {
      window_days: days,
      total_orders: 100,
      no_city_orders: 7,
      rows: [
        { city: 'Москва', orders: 44, sum: 362_000 },
        { city: 'Санкт-Петербург', orders: 29, sum: 248_000 },
        { city: 'Казань', orders: 20, sum: 151_000 },
      ],
    };
  }
  if (path === '/api/ms/channel-series') {
    const selected = (url.searchParams.get('channels') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const active = selected.length ? MS_CHANNELS.filter((channel) => selected.includes(channel.id)) : MS_CHANNELS;
    const count = days === 0 ? 90 : days;
    const dayKeys = Array.from({ length: count }, (_, index) =>
      new Date(Date.now() - (count - index - 1) * DAY_MS).toISOString().slice(0, 10),
    );
    const channelSeries = (channelIndex: number) =>
      dayKeys.map((day, index) => {
        const orders = (index + channelIndex) % 5 === 0 ? 0 : 1 + ((index + channelIndex) % 4);
        return {
          day,
          orders,
          sum: orders === 0 ? 0 : 4_500 + channelIndex * 1_700 + ((index * 977) % 5_200),
        };
      });
    const groups = active.map((channel) => {
      const sourceIndex = MS_CHANNELS.findIndex((item) => item.id === channel.id);
      return { sales_channel_id: channel.id, series: channelSeries(sourceIndex) };
    });
    return {
      window_days: days,
      channels: selected.length ? selected : null,
      series: dayKeys.map((day, index) => ({
        day,
        orders: groups.reduce((total, group) => total + group.series[index].orders, 0),
        sum: groups.reduce((total, group) => total + group.series[index].sum, 0),
      })),
      groups: url.searchParams.get('breakdown') === '1' ? groups : null,
      group_limit: groups.length,
      group_total: active.length,
    };
  }
  return undefined;
}

/**
 * Boot the app straight into the authenticated DEMO dashboard: stub /api/auth/me and set the demo
 * flag before load, so the whole Telegram dashboard renders from deterministic client-side fixtures —
 * no backend, no real credentials. Waits for the shell + first widget card, then a short settle so
 * ResizeObserver-driven chart heights are final before we measure them.
 * `opts.theme` pins the pulse_theme preference before load (default: system → the Playwright
 * environment's light) — the contrast gate scans both palettes explicitly.
 */
export async function bootDemo(
  page: Page,
  route = '/',
  opts: { theme?: 'light' | 'dark'; msMax?: boolean } = {},
): Promise<void> {
  // Covered demo endpoints resolve inside api/client.ts and never reach the network. Any uncovered
  // optional request (IG/media today, future integrations tomorrow) gets a deterministic response
  // instead of leaking through Vite's proxy to a missing local backend and filling CI with ECONNREFUSED.
  await page.route(/^https?:\/\/[^/]+\/api\//, (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname;
    const isMe = path === '/api/auth/me';
    const igPayload = demoIgPayload(path);
    const msPayload = demoMsPayload(url, { max: opts.msMax });
    return r.fulfill({
      status: isMe || igPayload !== undefined || msPayload !== undefined ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(isMe ? DEMO_ME : igPayload ?? msPayload ?? { error: 'not_available_in_demo' }),
    });
  });
  await page.addInitScript(
    (theme) => {
      localStorage.setItem('pulse_demo', '1');
      localStorage.setItem('pulse_channel', '0');
      if (theme) localStorage.setItem('pulse_theme', theme);
    },
    opts.theme ?? '',
  );
  await page.goto(route);
  // Wait for the authed shell (present on every route incl. an empty /home), then settle so
  // ResizeObserver-driven chart heights are final before any measurement.
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(1200);
}

/**
 * Operate a custom PillSelect (the accessible listbox that replaced native `<select>`). Opens the
 * trigger, then clicks the option — by exact `value` (matched via the option's `data-value`, the
 * closest analogue to the old `selectOption('value')`) or by visible `label`. Use this everywhere a
 * spec used to call `locator.selectOption(...)`.
 */
export async function selectPill(
  trigger: Locator,
  target: { value: string } | { label: string },
): Promise<void> {
  await trigger.click();
  const listbox = trigger.page().getByRole('listbox');
  await listbox.waitFor({ state: 'visible' });
  const option =
    'value' in target
      ? listbox.locator(`[role="option"][data-value="${target.value}"]`)
      : listbox.getByRole('option', { name: target.label, exact: true });
  await option.click();
}

/** A card that owns the generic ?detail= overlay rather than drilling to a dedicated metric page. */
export function detailOverlayOpener(page: Page): Locator {
  return page.getByRole('button', { name: 'Развернуть виджет «Лучшие публикации»' });
}

/**
 * Every card body (or any residual scroll container) that overflows its tile — the exact "no inner
 * scrollbars" invariant. Returns [] when clean; each entry names the widget for triage.
 */
export function overflowingCards(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('div.overflow-hidden, div.overflow-y-auto, div.overflow-auto')]
      .filter((el) => el.scrollHeight > el.clientHeight + 1)
      .map((el) => ({
        widget: (el.closest('section')?.querySelector('h3')?.textContent || '(unnamed)').trim(),
        over: el.scrollHeight - el.clientHeight,
      })),
  );
}
