// Фикстуры «МойСклада» демо-режима — клиентский порт серверных отчётов /api/ms/*.
//
// Почему клиентски: публичное демо (лендинг → «Смотреть демо») живёт БЕЗ серверной сессии —
// AuthGate синтезирует DEMO_ME, cookie нет, а все /api/ms/* стоят за requireAuth и отвечают 401.
// Ровно эта же дыра была закрыта для Instagram (см. demoIgFixtures.ts): рабочая поверхность
// показывала «Не удалось получить данные» вместо витрины. Поэтому демо обслуживает склад сам —
// детерминированными payload'ами (без Math.random: переживает StrictMode double-invoke).
//
// Инварианты витрины:
// - окно берётся ИЗ ЗАПРОСА ровно так, как его сериализует msPeriodQuery (`days` + опциональные
//   `from`/`to` — локальные календарные ключи); «Всё» (days=0) разворачивается в скользящее окно;
// - день ряда — функция КАЛЕНДАРНОГО дня, а не позиции в окне: иначе предыдущее равное окно
//   получило бы те же числа и все дельты карточек схлопнулись бы в 0%;
// - карточки не спорят между собой: воронка, покупатели, каналы и товары нарезаются из ОДНОГО
//   дневного ряда заказов, что и /api/ms/summary.

const DAY_MS = 86_400_000;

// Тот же детерминированный шум, что у demoIgFixtures: sin-хэш вместо RNG.
const seeded = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** epoch ms → ЛОКАЛЬНЫЙ YYYY-MM-DD (зеркало msDayKey: на нём же построены from/to запроса). */
const localDayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** Ключ дня → его порядковый номер (эпоха в сутках). Арифметика в UTC-полуночи ключа, поэтому
    шаг на ±1 всегда даёт соседний КАЛЕНДАРНЫЙ день и не спотыкается о переход на летнее время. */
const dayIndexOf = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};
const keyOfIndex = (index: number): string => {
  const d = new Date(index * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
const weekdayOfIndex = (index: number) => new Date(index * DAY_MS).getUTCDay();

// Якорь «сегодня» снимается ОДИН раз на загрузку модуля: внутри сессии окна, предыдущие окна и
// когорты обязаны быть согласованы между собой, а не разъезжаться от вызова к вызову.
const TODAY_KEY = localDayKey(Date.now());
const TODAY = dayIndexOf(TODAY_KEY);

/** Глубина скользящего окна «Всё» (days=0): архива у демо нет, но витрина должна показать историю. */
const ALL_TIME_DAYS = 180;
/** Предохранитель: пользовательский диапазон не должен раскрутить ряд на годы вперёд. */
const MAX_WINDOW_DAYS = 400;

interface MsWindow {
  /** Эхо запрошенного `days` — ровно оно уходит в `window_days` ответов (как у сервера). */
  days: number;
  /** Календарные ключи окна по возрастанию (включая обе границы). */
  keys: string[];
  /** Индексы тех же дней. */
  indexes: number[];
}

/** Окно запроса: точный `from`/`to` (пресет ИЛИ пользовательский диапазон — msPeriodQuery шлёт их
    одинаково), иначе `days` дней по сегодня; «Всё» — скользящие ALL_TIME_DAYS. */
function msWindow(params: URLSearchParams): MsWindow {
  const rawDays = Number.parseInt(params.get('days') ?? '', 10);
  const days = Number.isFinite(rawDays) ? rawDays : 30;
  const from = params.get('from');
  const to = params.get('to');
  let firstIndex: number;
  let lastIndex: number;
  if (from && to) {
    firstIndex = dayIndexOf(from);
    lastIndex = dayIndexOf(to);
    if (!Number.isFinite(firstIndex) || !Number.isFinite(lastIndex) || lastIndex < firstIndex) {
      firstIndex = TODAY - 29;
      lastIndex = TODAY;
    }
    firstIndex = Math.max(firstIndex, lastIndex - (MAX_WINDOW_DAYS - 1));
  } else {
    const span = days > 0 ? Math.min(days, MAX_WINDOW_DAYS) : ALL_TIME_DAYS;
    lastIndex = TODAY;
    firstIndex = TODAY - (span - 1);
  }
  const indexes: number[] = [];
  for (let i = firstIndex; i <= lastIndex; i++) indexes.push(i);
  return { days, keys: indexes.map(keyOfIndex), indexes };
}

/** Предыдущее равное окно — опора сравнения ассортимента (зеркало msPreviousPeriod). */
function previousWindow(w: MsWindow): MsWindow {
  const span = w.indexes.length;
  const lastIndex = w.indexes[0] - 1;
  const indexes: number[] = [];
  for (let i = lastIndex - span + 1; i <= lastIndex; i++) indexes.push(i);
  return { days: w.days, keys: indexes.map(keyOfIndex), indexes };
}

// ── Дневной ряд заказов — единственный источник правды всех складских карточек ────────────────
interface MsDay {
  day: string;
  index: number;
  count: number;
  sum: number;
}

/**
 * Заказы одного календарного дня. Выходные приглушены, свежие дни чуть плотнее старых (мягкий
 * рост → честная положительная дельта к предыдущему равному окну), средний чек тоже медленно
 * растёт. Дней без заказов нет: витрина показывает работающий магазин, а не простой.
 */
function msDay(index: number): MsDay {
  const age = Math.max(0, TODAY - index);
  const weekday = weekdayOfIndex(index);
  const damp = weekday === 0 ? 0.62 : weekday === 6 ? 0.74 : 1;
  const trend = 9.4 - Math.min(age, ALL_TIME_DAYS) * 0.014;
  const count = Math.max(1, Math.round((trend + (seeded(index * 7 + 3) - 0.5) * 4.6) * damp));
  const check = 4_600 + Math.round(seeded(index * 13 + 11) * 2_800) - Math.min(age, ALL_TIME_DAYS) * 4;
  return { day: keyOfIndex(index), index, count, sum: count * check };
}

const msDays = (w: MsWindow): MsDay[] => w.indexes.map(msDay);
const sumBy = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);

// ── /api/ms/summary ───────────────────────────────────────────────────────────────────────────
function msSummary(w: MsWindow) {
  const rows = msDays(w);
  return {
    revenue: {
      total: sumBy(rows, (r) => r.sum),
      series: rows.map((r) => ({ day: r.day, value: r.sum })),
    },
    orders: {
      totalSum: sumBy(rows, (r) => r.sum),
      totalCount: sumBy(rows, (r) => r.count),
      series: rows.map((r) => ({ day: r.day, count: r.count, sum: r.sum })),
    },
  };
}

// ── /api/ms/funnel ────────────────────────────────────────────────────────────────────────────
// Статусы заказов реального склада: доли фиксированы, абсолютные числа режутся из окна, поэтому
// «всего заказов» воронки совпадает со счётчиком карточки «Заказы».
const MS_STATES = [
  { state_id: 'ms-new', name: 'Новый', color: '#4a90d9', share: 0.16 },
  { state_id: 'ms-confirmed', name: 'Подтверждён', color: '#2e8b57', share: 0.13 },
  { state_id: 'ms-packed', name: 'Собран на складе', color: '#f5a623', share: 0.12 },
  { state_id: 'ms-shipped', name: 'Передан в доставку', color: '#7b61ff', share: 0.15 },
  { state_id: 'ms-delivered', name: 'Доставлен', color: '#50b0a0', share: 0.34 },
  { state_id: 'ms-returned', name: 'Возврат оформлен', color: '#c0504d', share: 0.05 },
  { state_id: 'ms-canceled', name: 'Отменён покупателем', color: '#9b59b6', share: 0.05 },
];

function msFunnel(w: MsWindow) {
  const rows = msDays(w);
  const totalOrders = sumBy(rows, (r) => r.count);
  const totalSum = sumBy(rows, (r) => r.sum);
  const avgCheck = totalOrders > 0 ? totalSum / totalOrders : 0;
  // Заказы без статуса — честный хвост склада; остальное раскладывается по долям, остаток
  // отдаётся последней строке, чтобы сумма строк + хвост в ТОЧНОСТИ дала итог окна.
  const noStateOrders = Math.min(totalOrders, Math.max(1, Math.round(totalOrders * 0.02)));
  const distributable = totalOrders - noStateOrders;
  let assigned = 0;
  const stateRows = MS_STATES.map((state, i) => {
    const orders =
      i === MS_STATES.length - 1 ? Math.max(0, distributable - assigned) : Math.round(distributable * state.share);
    assigned += orders;
    return {
      state_id: state.state_id,
      name: state.name,
      color: state.color,
      orders,
      sum: Math.round(orders * avgCheck),
    };
  });
  return {
    window_days: w.days,
    total_orders: totalOrders,
    no_state_orders: noStateOrders,
    no_state_sum: Math.round(noStateOrders * avgCheck),
    rows: stateRows,
  };
}

// ── /api/ms/customers ─────────────────────────────────────────────────────────────────────────
function msCustomers(w: MsWindow) {
  const series = msDays(w).map((row) => {
    // Доля новых заказов колеблется вокруг 58% — повторные покупки в демо есть, но не доминируют.
    const newShare = 0.5 + seeded(row.index * 17 + 5) * 0.18;
    const newOrders = Math.min(row.count, Math.max(0, Math.round(row.count * newShare)));
    const repeatOrders = row.count - newOrders;
    const check = row.count > 0 ? row.sum / row.count : 0;
    return {
      day: row.day,
      new_orders: newOrders,
      repeat_orders: repeatOrders,
      sum_new: Math.round(newOrders * check),
      // Повторный клиент берёт чуть дороже — знакомая корзина крупнее первой.
      sum_repeat: Math.round(repeatOrders * check * 1.18),
    };
  });
  const ordersNew = sumBy(series, (r) => r.new_orders);
  const ordersRepeat = sumBy(series, (r) => r.repeat_orders);
  // Новый заказ = новый покупатель; повторные заказы приходят пачками (~2.3 на клиента).
  const newCustomers = ordersNew;
  const repeatCustomers = Math.max(1, Math.round(ordersRepeat / 2.3));
  const customers = newCustomers + repeatCustomers;
  return {
    window_days: w.days,
    summary: {
      customers,
      new_customers: newCustomers,
      repeat_customers: repeatCustomers,
      orders_new: ordersNew,
      orders_repeat: ordersRepeat,
      sum_new: sumBy(series, (r) => r.sum_new),
      sum_repeat: sumBy(series, (r) => r.sum_repeat),
      no_agent_orders: 3,
      // Клиентов с ≥2 заказами за ВСЮ историю больше, чем повторных в окне, но не больше базы:
      // карточка «Повторные покупки» на «Всё» делит одно на другое и получила бы >100%.
      repeat_ever: Math.min(customers, Math.round(repeatCustomers * 1.9)),
    },
    series,
  };
}

// ── /api/ms/rfm + /api/ms/rfm-customers ───────────────────────────────────────────────────────
// Сегменты фиксированы (RFM считается по всей истории архива, а не по окну); листинг покупателей
// берёт свой total ИЗ ЭТОЙ ЖЕ таблицы, иначе карточка сегмента и его страница разошлись бы.
const RFM_SEGMENTS = [
  { key: 'champions', customers: 148, orders: 612, sum: 7_940_000, recency: 4 },
  { key: 'loyal', customers: 96, orders: 288, sum: 3_180_000, recency: 11 },
  { key: 'potential', customers: 72, orders: 121, sum: 1_260_000, recency: 19 },
  { key: 'new', customers: 61, orders: 61, sum: 520_000, recency: 6 },
  { key: 'at_risk', customers: 44, orders: 96, sum: 880_000, recency: 47 },
  { key: 'hibernating', customers: 27, orders: 41, sum: 310_000, recency: 96 },
] as const;

const RFM_TOTALS: Record<string, number> = Object.fromEntries(
  RFM_SEGMENTS.map((segment) => [segment.key, segment.customers]),
);

function msRfm(w: MsWindow) {
  return {
    window_days: w.days,
    as_of: TODAY_KEY,
    customers: sumBy([...RFM_SEGMENTS], (s) => s.customers),
    no_agent_orders: 3,
    total_orders: sumBy([...RFM_SEGMENTS], (s) => s.orders),
    total_sum: sumBy([...RFM_SEGMENTS], (s) => s.sum),
    segments: RFM_SEGMENTS.map((segment) => ({
      key: segment.key,
      customers: segment.customers,
      orders: segment.orders,
      sum: segment.sum,
      average_recency_days: segment.recency,
      // Средние выводятся из тех же чисел — расхождения между строкой и её сводкой быть не может.
      average_frequency: Math.round((segment.orders / segment.customers) * 10) / 10,
      average_monetary: Math.round(segment.sum / segment.customers),
    })),
  };
}

const RFM_CITIES = ['Москва', 'Санкт-Петербург', 'Екатеринбург', 'Казань', 'Новосибирск'];
const RFM_NAME_FORMS = ['ООО «Ромашка»', 'ИП Смирнов', 'ООО «Северный дом»', 'ИП Ковалёва', 'ООО «Аврора»'];

function msRfmCustomers(w: MsWindow, params: URLSearchParams) {
  const segment = params.get('segment') ?? 'champions';
  const total = RFM_TOTALS[segment] ?? 0;
  // Пагинация как у сервера: limit кэпится 200, offset неотрицателен.
  const rawLimit = Number.parseInt(params.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 50;
  const rawOffset = Number.parseInt(params.get('offset') ?? '', 10);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
  const recencyBase = RFM_SEGMENTS.find((s) => s.key === segment)?.recency ?? 10;
  const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => {
    const n = offset + i + 1;
    const recency = recencyBase + (n % 7);
    return {
      agent_id: `${segment}-${n}`,
      name: `${RFM_NAME_FORMS[n % RFM_NAME_FORMS.length]} ${n}`,
      address: n % 3 === 0 ? `ул. Складская, д. ${n}` : null,
      phone: n % 2 === 0 ? `+7 900 ${String(1_000_000 + n * 37).slice(1)}` : null,
      email: n % 4 === 0 ? `client${n}@example.com` : null,
      city: n % 3 === 0 ? RFM_CITIES[n % RFM_CITIES.length] : null,
      orders: 1 + (n % 6),
      sum: 12_000 + n * 640,
      last_day: keyOfIndex(TODAY - recency),
      recency_days: recency,
      r: 1 + (n % 5),
      f: 1 + (n % 5),
      m: 1 + ((n + 2) % 5),
    };
  });
  return {
    window_days: w.days,
    as_of: TODAY_KEY,
    segment,
    total_customers: total,
    rows,
  };
}

// ── /api/ms/cohorts ───────────────────────────────────────────────────────────────────────────
/** Месяц когорты в `YYYY-MM`, отсчитанный назад от текущего (клетки — только НАСТУПИВШИЕ месяцы). */
function cohortMonth(monthsAgo: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function msCohorts() {
  const DEPTH = 6;
  return {
    cohorts: Array.from({ length: DEPTH }, (_, i) => {
      const monthsAgo = DEPTH - 1 - i;
      // Когорты растут от старых к свежим (магазин набирает базу), шум — только поверх тренда:
      // прыгающий размер читался бы как сбой сбора, а не как история.
      const size = 24 + (DEPTH - 1 - monthsAgo) * 5 + Math.round(seeded(monthsAgo * 29 + 7) * 6);
      return {
        cohort_month: cohortMonth(monthsAgo),
        size,
        // Ретеншен спадает, выручка когорты вслед за ним; клеток ровно столько, сколько месяцев
        // когорта успела прожить.
        cells: Array.from({ length: monthsAgo + 1 }, (_, offset) => {
          const retention = offset === 0 ? 1 : Math.max(0.12, 0.56 * 0.78 ** (offset - 1));
          const active = Math.max(1, Math.round(size * retention));
          return { offset, active, revenue: active * (4_800 + Math.round(seeded(offset * 31 + monthsAgo) * 2_600)) };
        }),
      };
    }),
  };
}

// ── /api/ms/top-customers ─────────────────────────────────────────────────────────────────────
const TOP_CUSTOMERS = [
  { agent_id: 'top-1', name: 'ООО «Северный дом»', orders: 12, share: 0.062 },
  { agent_id: 'top-2', name: 'ИП Ковалёва А. В.', orders: 9, share: 0.048 },
  { agent_id: 'top-3', name: 'ООО «Аврора Трейд»', orders: 8, share: 0.041 },
  { agent_id: 'top-4', name: 'ИП Смирнов Д. И.', orders: 6, share: 0.033 },
  { agent_id: 'top-5', name: 'ООО «Ромашка»', orders: 5, share: 0.027 },
];

function msTopCustomers(w: MsWindow) {
  const totalSum = sumBy(msDays(w), (r) => r.sum);
  return {
    window_days: w.days,
    rows: TOP_CUSTOMERS.map((row) => ({
      agent_id: row.agent_id,
      name: row.name,
      orders: row.orders,
      sum: Math.round(totalSum * row.share),
    })),
  };
}

// ── /api/ms/returns ───────────────────────────────────────────────────────────────────────────
function msReturns(w: MsWindow) {
  const series = msDays(w)
    .map((row) => {
      // Возврат примерно раз в пять дней — разреженный ряд, как в проде (сервер отдаёт только дни
      // С возвратами, календарь дозаполняет фронт).
      const has = row.index % 5 === 0;
      const count = has ? 1 + (row.index % 2) : 0;
      return {
        day: row.day,
        count,
        sum: count === 0 ? 0 : count * (3_200 + Math.round(seeded(row.index * 19 + 2) * 4_400)),
      };
    })
    .filter((row) => row.count > 0);
  const archived = sumBy(series, (r) => r.count);
  return {
    window_days: w.days,
    archive_status: 'done',
    complete: true,
    archived_count: archived,
    total_estimate: archived,
    count: archived,
    sum: sumBy(series, (r) => r.sum),
    series,
  };
}

// ── /api/ms/stock ─────────────────────────────────────────────────────────────────────────────
// Прод-форма: сортировка days_left ASC NULLS LAST; первая строка «скоро кончится» (≤7 дн.)
// отрабатывает warn-подсветку карточки «Остатки».
const MS_STOCK_ROWS = [
  { id: 'sku-coffee', name: 'Кофемашина автоматическая De Longhi Magnifica S', stock: 3, reserve: 1, days_left: 4, sold_window: 21 },
  { id: 'sku-buds', name: 'Наушники Apple AirPods Pro 2-го поколения USB-C', stock: 18, reserve: 3, days_left: 9, sold_window: 58 },
  { id: 'sku-tv', name: 'Телевизор LG OLED evo C4 65 дюймов 4K', stock: 12, reserve: 0, days_left: 18, sold_window: 20 },
  { id: 'sku-console', name: 'Игровая консоль Sony PlayStation 5 Slim', stock: 25, reserve: 2, days_left: 47, sold_window: 16 },
  { id: 'sku-vacuum', name: 'Робот-пылесос Dreame X40 Ultra', stock: 40, reserve: 0, days_left: 160, sold_window: 8 },
  { id: 'sku-garland', name: 'Гирлянда новогодняя LED 20 м', stock: 90, reserve: 0, days_left: null, sold_window: 0 },
];

const msStock = (w: MsWindow) => ({ window_days: w.days === 0 ? 30 : w.days, rows: MS_STOCK_ROWS });

// ── /api/ms/sales-by-channel + /api/ms/channel-series ─────────────────────────────────────────
const MS_CHANNELS = [
  { id: 'ch-shop', name: 'Интернет-магазин', type: 'ECOMMERCE', share: 0.46 },
  { id: 'ch-market', name: 'Маркетплейсы', type: 'ECOMMERCE', share: 0.24 },
  { id: 'ch-partners', name: 'Партнёры', type: 'DIRECT_SALES', share: 0.18 },
  { id: 'ch-retail', name: 'Розница', type: 'OTHER', share: 0.12 },
];

/** Разложение дня по каналам продаж: сперва отрезается «без канала», остаток делится по долям,
    последний канал забирает остаток — сумма разложения ТОЧНО равна заказам дня. */
function channelSplit(row: MsDay): { noChannel: number; perChannel: number[] } {
  const noChannel = row.index % 7 === 3 && row.count > 1 ? 1 : 0;
  const rest = row.count - noChannel;
  let assigned = 0;
  const perChannel = MS_CHANNELS.map((channel, i) => {
    const value = i === MS_CHANNELS.length - 1 ? Math.max(0, rest - assigned) : Math.round(rest * channel.share);
    assigned += value;
    return value;
  });
  return { noChannel, perChannel };
}

function msSalesByChannel(w: MsWindow) {
  const rows = msDays(w);
  const totalOrders = sumBy(rows, (r) => r.count);
  const totalSum = sumBy(rows, (r) => r.sum);
  const avgCheck = totalOrders > 0 ? totalSum / totalOrders : 0;
  const splits = rows.map(channelSplit);
  const noChannelOrders = sumBy(splits, (s) => s.noChannel);
  return {
    window_days: w.days,
    total_orders: totalOrders,
    no_channel_orders: noChannelOrders,
    no_channel_sum: Math.round(noChannelOrders * avgCheck),
    rows: MS_CHANNELS.map((channel, i) => {
      const orders = sumBy(splits, (s) => s.perChannel[i]);
      return {
        sales_channel_id: channel.id,
        name: channel.name,
        type: channel.type,
        orders,
        // Средний чек канала свой: розница мельче, маркетплейсы крупнее — доли выручки и заказов
        // не обязаны совпадать (иначе разрез ничего не рассказывает).
        sum: Math.round(orders * avgCheck * (0.86 + i * 0.11)),
      };
    }),
  };
}

function msChannelSeries(w: MsWindow, params: URLSearchParams) {
  const selected = (params.get('channels') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const activeIndexes = MS_CHANNELS.map((channel, i) => (selected.length === 0 || selected.includes(channel.id) ? i : -1))
    .filter((i) => i >= 0);
  const rows = msDays(w);
  const totalOrders = sumBy(rows, (r) => r.count);
  const totalSum = sumBy(rows, (r) => r.sum);
  const avgCheck = totalOrders > 0 ? totalSum / totalOrders : 0;
  const dayOf = (row: MsDay, channelIndex: number) => {
    const orders = channelSplit(row).perChannel[channelIndex];
    return {
      day: row.day,
      orders,
      sum: Math.round(orders * avgCheck * (0.86 + channelIndex * 0.11)),
    };
  };
  const groups = activeIndexes.map((i) => ({
    sales_channel_id: MS_CHANNELS[i].id,
    series: rows.map((row) => dayOf(row, i)),
  }));
  return {
    window_days: w.days,
    channels: selected.length ? selected : null,
    // Агрегат — сумма выбранных каналов (канон «фильтр = агрегат»).
    series: rows.map((row, dayIdx) => ({
      day: row.day,
      orders: sumBy(groups, (g) => g.series[dayIdx].orders),
      sum: sumBy(groups, (g) => g.series[dayIdx].sum),
    })),
    groups: params.get('breakdown') === '1' ? groups : null,
    group_limit: groups.length,
    group_total: activeIndexes.length,
  };
}

// ── /api/ms/geography ─────────────────────────────────────────────────────────────────────────
const MS_CITIES = [
  { city: 'Москва', share: 0.33 },
  { city: 'Санкт-Петербург', share: 0.19 },
  { city: 'Екатеринбург', share: 0.11 },
  { city: 'Новосибирск', share: 0.09 },
  { city: 'Нижний Новгород', share: 0.07 },
  { city: 'Казань', share: 0.06 },
  { city: 'Ростов-на-Дону', share: 0.05 },
  { city: 'Челябинск', share: 0.04 },
];

function msGeography(w: MsWindow) {
  const rows = msDays(w);
  const totalOrders = sumBy(rows, (r) => r.count);
  const totalSum = sumBy(rows, (r) => r.sum);
  const avgCheck = totalOrders > 0 ? totalSum / totalOrders : 0;
  const noCityOrders = Math.min(totalOrders, Math.max(1, Math.round(totalOrders * 0.06)));
  const distributable = totalOrders - noCityOrders;
  let assigned = 0;
  const cityRows = MS_CITIES.map((city, i) => {
    const orders =
      i === MS_CITIES.length - 1 ? Math.max(0, distributable - assigned) : Math.round(distributable * city.share);
    assigned += orders;
    return { city: city.city, orders, sum: Math.round(orders * avgCheck) };
  });
  return { window_days: w.days, total_orders: totalOrders, no_city_orders: noCityOrders, rows: cityRows };
}

// ── /api/ms/top-products (+ compare=prev) ─────────────────────────────────────────────────────
/** Каталог демо-склада. `share` — доля выручки в ТЕКУЩЕМ окне, `prevShare` — в предыдущем равном:
    нулевая доля с одной из сторон и даёт честные «появились» / «пропали» вкладки «Динамика». */
const MS_PRODUCTS = [
  { name: 'Кофемашина автоматическая De Longhi Magnifica S', price: 62_000, share: 0.19, prevShare: 0.15, marginPct: 20.5 },
  { name: 'Робот-пылесос Dreame X40 Ultra', price: 58_000, share: 0.16, prevShare: 0.19, marginPct: 21 },
  { name: 'Смартфон Samsung Galaxy S24 Ultra 512 ГБ', price: 118_000, share: 0.14, prevShare: 0.13, marginPct: 12.4 },
  { name: 'Наушники Apple AirPods Pro 2-го поколения USB-C', price: 21_000, share: 0.12, prevShare: 0.09, marginPct: 25 },
  { name: 'Телевизор LG OLED evo C4 65 дюймов 4K', price: 174_000, share: 0.11, prevShare: 0.14, marginPct: 9.8 },
  { name: 'Игровая консоль Sony PlayStation 5 Slim', price: 64_000, share: 0.09, prevShare: 0.11, marginPct: 8.2 },
  { name: 'Планшет Apple iPad Air 11" M2', price: 79_000, share: 0.07, prevShare: 0.08, marginPct: 14.6 },
  { name: 'Умная колонка «Станция Миди»', price: 17_000, share: 0.05, prevShare: 0.06, marginPct: 18.3 },
  { name: 'Электросамокат Ninebot Max G2', price: 73_000, share: 0.04, prevShare: 0.05, marginPct: -6.4 },
  { name: 'Фен-стайлер Dyson Airwrap Complete', price: 54_000, share: 0.03, prevShare: 0, marginPct: 22.8 },
  { name: 'Гирлянда новогодняя LED 20 м', price: 1_900, share: 0, prevShare: 0.04, marginPct: 27 },
];

interface MsProductRow {
  name: string;
  quantity: number;
  revenue: number;
  profit: number;
  margin: number | null;
}

/** Строки каталога, нарезанные под выручку окна. Товар без продаж честно несёт нули и margin=null. */
function productRows(totalRevenue: number, share: (p: (typeof MS_PRODUCTS)[number]) => number): MsProductRow[] {
  return MS_PRODUCTS.map((product) => {
    const revenue = Math.round(totalRevenue * share(product));
    const profit = Math.round((revenue * product.marginPct) / 100);
    return {
      name: product.name,
      quantity: revenue > 0 ? Math.max(1, Math.round(revenue / product.price)) : 0,
      revenue,
      profit,
      margin: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : null,
    };
  });
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Сводка концентрации — считается по ПОЛНОМУ каталогу (как сервер по raw-отчёту до limit). */
function productSummary(rows: MsProductRow[]) {
  const revenuePositive = rows.filter((r) => r.revenue > 0).map((r) => r.revenue);
  const profitPositive = rows.filter((r) => r.profit > 0).map((r) => r.profit);
  const revenuePositiveTotal = revenuePositive.reduce((a, b) => a + b, 0);
  const profitPositiveTotal = profitPositive.reduce((a, b) => a + b, 0);
  const top = (values: number[]) => [...values].sort((a, b) => b - a).slice(0, 10).reduce((a, b) => a + b, 0);
  const revenueTotal = rows.reduce((a, r) => a + r.revenue, 0);
  const profitTotal = rows.reduce((a, r) => a + r.profit, 0);
  const losses = rows.filter((r) => r.profit < 0);
  return {
    complete: true,
    product_count: rows.length,
    top_n: 10,
    revenue_positive_total: revenuePositiveTotal,
    profit_positive_total: profitPositiveTotal,
    revenue_top10_share_pct: revenuePositiveTotal > 0 ? round1((top(revenuePositive) / revenuePositiveTotal) * 100) : null,
    profit_top10_share_pct: profitPositiveTotal > 0 ? round1((top(profitPositive) / profitPositiveTotal) * 100) : null,
    net_margin_pct: revenueTotal > 0 ? round1((profitTotal / revenueTotal) * 100) : null,
    loss_making_count: losses.length,
    loss_making_amount: losses.reduce((a, r) => a + Math.abs(r.profit), 0),
  };
}

type MoverMetric = 'revenue' | 'profit' | 'units';

/** Один показатель сравнения ассортимента: движения делятся на четыре корзины, deltaPct честно
    null при неположительной прошлой базе (ноль не даёт конечного процента). */
function moversFor(current: MsProductRow[], previous: MsProductRow[], metric: MoverMetric, limit: number) {
  const value = (row: MsProductRow) => (metric === 'revenue' ? row.revenue : metric === 'profit' ? row.profit : row.quantity);
  const movers = current.map((row, i) => {
    const cur = value(row);
    const prev = value(previous[i]);
    const delta = cur - prev;
    return { name: row.name, current: cur, previous: prev, delta, deltaPct: prev > 0 ? round1((delta / prev) * 100) : null };
  });
  const both = movers.filter((m) => m.current !== 0 && m.previous !== 0);
  return {
    unit: metric === 'units' ? ('count' as const) : ('rub' as const),
    gainers: both.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit),
    losers: both.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit),
    appeared: movers.filter((m) => m.previous === 0 && m.current !== 0).slice(0, limit),
    disappeared: movers.filter((m) => m.current === 0 && m.previous !== 0).slice(0, limit),
  };
}

function msAssortmentComparison(w: MsWindow) {
  // «Всё» честного предшественника не имеет — сервер отвечает недоступностью, а не выдумкой.
  if (w.days === 0) return { available: false as const, reason: 'all' };
  const prev = previousWindow(w);
  const current = productRows(sumBy(msDays(w), (r) => r.sum), (p) => p.share);
  const previous = productRows(sumBy(msDays(prev), (r) => r.sum), (p) => p.prevShare);
  const limit = 5;
  const currentOnly = current.filter((row, i) => row.revenue > 0 && previous[i].revenue === 0).length;
  const previousOnly = current.filter((row, i) => row.revenue === 0 && previous[i].revenue > 0).length;
  return {
    available: true as const,
    partial: false,
    identity_fallback_count: 0,
    current: { from: w.keys[0], to: w.keys[w.keys.length - 1] },
    previous: { from: prev.keys[0], to: prev.keys[prev.keys.length - 1] },
    counts: { current_only: currentOnly, previous_only: previousOnly, both: current.length - currentOnly - previousOnly },
    metrics: {
      revenue: moversFor(current, previous, 'revenue', limit),
      profit: moversFor(current, previous, 'profit', limit),
      units: moversFor(current, previous, 'units', limit),
    },
    limit,
  };
}

function msTopProducts(w: MsWindow, params: URLSearchParams) {
  const sort = params.get('sort') ?? 'revenue';
  const rawLimit = Number.parseInt(params.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, rawLimit) : 10;
  const rows = productRows(sumBy(msDays(w), (r) => r.sum), (p) => p.share);
  const summary = productSummary(rows);
  const metric = (row: MsProductRow) => (sort === 'profit' ? row.profit : sort === 'margin' ? row.margin : row.revenue);
  const sorted = [...rows].sort((a, b) => {
    const av = metric(a);
    const bv = metric(b);
    if (av == null && bv != null) return 1;
    if (av != null && bv == null) return -1;
    return (bv ?? 0) - (av ?? 0) || a.name.localeCompare(b.name, 'ru');
  });
  const body: Record<string, unknown> = {
    rows: sorted.slice(0, limit),
    total: rows.length,
    truncated: rows.length > limit,
    summary,
  };
  // Сравнение с предыдущим равным окном — ТОЛЬКО по opt-in (вкладка «Динамика»), как у сервера.
  if (params.get('compare') === 'prev') body.comparison = msAssortmentComparison(w);
  return body;
}

/**
 * МС-неймспейс демо-фикстур: путь (с query) → payload, `undefined` = не покрыто (уйдёт на сервер,
 * где неавторизованное демо получит 401 — поэтому всё, что /sklad реально запрашивает, обязано
 * быть перечислено здесь).
 */
export function msDemoFixture(path: string): unknown | undefined {
  const [p, qs = ''] = path.split('?');
  const params = new URLSearchParams(qs);
  // Статус источника: демо-склад ПОДКЛЮЧЁН — иначе /connect и орбита звали бы подключать то,
  // что уже показывает данные.
  if (p === '/api/ms/status') return { connected: true, org_name: 'Демо-организация' };
  if (p === '/api/ms/backfill-status') {
    const archived = sumBy(msDays(msWindow(new URLSearchParams('days=180'))), (r) => r.count);
    return { status: 'done', fetched: archived, total: archived, cursor_month: null, orders_in_db: archived, error: null };
  }
  // Когорты окна не имеют (весь архив) — единственная семья без периода в query.
  if (p === '/api/ms/cohorts') return msCohorts();

  const w = msWindow(params);
  if (p === '/api/ms/summary') return msSummary(w);
  if (p === '/api/ms/funnel') return msFunnel(w);
  if (p === '/api/ms/customers') return msCustomers(w);
  if (p === '/api/ms/rfm') return msRfm(w);
  if (p === '/api/ms/rfm-customers') return msRfmCustomers(w, params);
  if (p === '/api/ms/top-customers') return msTopCustomers(w);
  if (p === '/api/ms/returns') return msReturns(w);
  if (p === '/api/ms/stock') return msStock(w);
  if (p === '/api/ms/sales-by-channel') return msSalesByChannel(w);
  if (p === '/api/ms/channel-series') return msChannelSeries(w, params);
  if (p === '/api/ms/geography') return msGeography(w);
  if (p === '/api/ms/top-products') return msTopProducts(w, params);
  return undefined;
}
