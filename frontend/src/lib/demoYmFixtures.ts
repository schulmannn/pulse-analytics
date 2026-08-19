// Фикстуры «Яндекс.Метрики» демо-режима — клиентский порт серверных отчётов /api/ym/*.
//
// Почему клиентски: публичное демо (лендинг → «Смотреть демо») живёт БЕЗ серверной сессии —
// AuthGate синтезирует DEMO_ME, cookie нет, а все /api/ym/* стоят за requireAuth и отвечают 401.
// Та же дыра была закрыта для Instagram (demoIgFixtures.ts) и МойСклада (demoMsFixtures.ts):
// рабочая поверхность показывала «Не удалось получить данные Яндекс.Метрики» вместо витрины.
//
// Инварианты витрины (зеркало demoMsFixtures):
// - окно берётся ИЗ ЗАПРОСА ровно так, как его сериализует msPeriodQuery (Метрика ходит тем же
//   сете-агностичным сериализатором окон, что и склад): `days` + опциональные `from`/`to`;
// - день ряда — функция КАЛЕНДАРНОГО дня, а не позиции в окне: иначе предыдущее равное окно
//   получило бы те же числа и дельты карточек схлопнулись бы в 0%;
// - 17 разрезов нарезаются из ОДНОГО дневного ряда визитов, поэтому доски и страницы `/metrics/ym-*`
//   не спорят друг с другом; без Math.random (переживает StrictMode double-invoke).

const DAY_MS = 86_400_000;

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

const dayIndexOf = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};
const keyOfIndex = (index: number): string => {
  const d = new Date(index * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
const weekdayOfIndex = (index: number) => new Date(index * DAY_MS).getUTCDay();

// Якорь «сегодня» снимается ОДИН раз на загрузку модуля (см. demoMsFixtures).
const TODAY_KEY = localDayKey(Date.now());
const TODAY = dayIndexOf(TODAY_KEY);

const ALL_TIME_DAYS = 180;
const MAX_WINDOW_DAYS = 400;

interface YmWindow {
  /** Эхо запрошенного `days` (нужно только для отметки «Всё» в meta). */
  days: number;
  keys: string[];
  indexes: number[];
}

/** Окно запроса: точный `from`/`to` (пресет ИЛИ пользовательский диапазон), иначе `days` дней по
    сегодня; «Всё» (days=0) — скользящие ALL_TIME_DAYS. */
function ymWindow(params: URLSearchParams): YmWindow {
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

// ── Дневной ряд трафика — единственный источник правды всех разрезов ──────────────────────────
interface YmDay {
  day: string;
  index: number;
  visits: number;
  users: number;
  pageviews: number;
  newUsers: number;
  bounceRate: number;
  duration: number;
  robotVisits: number;
}

/**
 * Трафик одного календарного дня. Будни плотнее выходных, свежие дни чуть выше старых (мягкий
 * рост → честная положительная дельта к предыдущему равному окну). Посетители — доля визитов
 * (визит ≠ посетитель), просмотры — визиты × глубина.
 */
function ymDay(index: number): YmDay {
  const age = Math.max(0, TODAY - index);
  const weekday = weekdayOfIndex(index);
  const damp = weekday === 0 ? 0.66 : weekday === 6 ? 0.72 : 1;
  const trend = 1_240 - Math.min(age, ALL_TIME_DAYS) * 1.9;
  const visits = Math.max(1, Math.round((trend + (seeded(index * 11 + 5) - 0.5) * 460) * damp));
  const users = Math.max(1, Math.round(visits * (0.66 + seeded(index * 17 + 9) * 0.08)));
  const depth = 2.4 + seeded(index * 23 + 3) * 0.9;
  return {
    day: keyOfIndex(index),
    index,
    visits,
    users,
    pageviews: Math.round(visits * depth),
    newUsers: Math.round(users * (0.38 + seeded(index * 29 + 13) * 0.12)),
    bounceRate: Math.round((26 + seeded(index * 31 + 7) * 12) * 10) / 10,
    duration: Math.round(96 + seeded(index * 37 + 19) * 64),
    robotVisits: Math.round(visits * (0.04 + seeded(index * 41 + 23) * 0.035)),
  };
}

const ymDays = (w: YmWindow): YmDay[] => w.indexes.map(ymDay);
const sumBy = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

// ── /api/ym/summary ───────────────────────────────────────────────────────────────────────────
function ymSummary(w: YmWindow) {
  const rows = ymDays(w);
  const visitsTotal = sumBy(rows, (r) => r.visits);
  const usersTotal = sumBy(rows, (r) => r.users);
  const pageviewsTotal = sumBy(rows, (r) => r.pageviews);
  const newUsersTotal = sumBy(rows, (r) => r.newUsers);
  const robotTotal = sumBy(rows, (r) => r.robotVisits);
  // Итоги качества — ВЗВЕШЕННЫЕ по визитам, а не средние по дням: так их и считает Reporting API.
  const weighted = (pick: (row: YmDay) => number) =>
    visitsTotal > 0 ? sumBy(rows, (r) => pick(r) * r.visits) / visitsTotal : null;
  const series = (pick: (row: YmDay) => number) => rows.map((r) => ({ day: r.day, value: pick(r) }));
  return {
    visits: { total: visitsTotal, series: series((r) => r.visits) },
    users: { total: usersTotal, series: series((r) => r.users) },
    pageviews: { total: pageviewsTotal, series: series((r) => r.pageviews) },
    quality: {
      bounce_rate: round1(weighted((r) => r.bounceRate) ?? 0),
      avg_visit_duration_seconds: Math.round(weighted((r) => r.duration) ?? 0),
      page_depth: visitsTotal > 0 ? round2(pageviewsTotal / visitsTotal) : null,
      new_users: newUsersTotal,
      percent_new_visitors: usersTotal > 0 ? round1((newUsersTotal / usersTotal) * 100) : null,
      robot_visits: robotTotal,
      robot_percentage: visitsTotal > 0 ? round1((robotTotal / visitsTotal) * 100) : null,
    },
    quality_series: {
      bounce_rate: series((r) => r.bounceRate),
      avg_visit_duration_seconds: series((r) => r.duration),
      page_depth: series((r) => round2(r.pageviews / r.visits)),
      new_users: series((r) => r.newUsers),
      percent_new_visitors: series((r) => round1((r.newUsers / r.users) * 100)),
      robot_visits: series((r) => r.robotVisits),
      robot_percentage: series((r) => round1((r.robotVisits / r.visits) * 100)),
    },
    // Точные итоги периода есть (демо-счётчик «отвечает» живым отчётом), поэтому подписи
    // «сумма по дням» у «Посетителей» нет; сэмплирования у демо тоже нет.
    meta: {
      exact_period_totals: true,
      all_time: w.days === 0,
      archive_last_day: TODAY_KEY,
      sampled: false,
    },
  };
}

// ── Общая машинка разрезов ────────────────────────────────────────────────────────────────────
interface YmRowDef {
  id: string | null;
  name: string;
  /** Доля визитов разреза. Сумма долей МЕНЬШЕ 1 — остаток честно уходит в хвост «Ещё N из M». */
  share: number;
  /** Конверсия выбранной цели по строке, % (аддитивная атрибуция). */
  cr?: number;
}

/** Положительный id цели или null — зеркало серверного числового гейта (ymGoalParam на клиенте). */
function goalIdOf(params: URLSearchParams): number | null {
  const raw = Number.parseInt(params.get('goal_id') ?? '', 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Строки разреза из долей визитов. `bounce` включает построчные отказы (у источников их нет —
 * контракт /api/ym/sources уже, чем у общего breakdown). `goalId != null` добавляет достижения и
 * конверсию цели АДДИТИВНО, как это делает сервер.
 */
function ymRows(
  defs: YmRowDef[],
  scopeVisits: number,
  opts: { bounce?: boolean; goalId?: number | null } = {},
) {
  return defs.map((def, i) => {
    const visits = Math.max(0, Math.round(scopeVisits * def.share));
    const users = Math.max(0, Math.round(visits * (0.62 + seeded(i * 13 + 3) * 0.16)));
    const row: Record<string, unknown> = { id: def.id, name: def.name, visits, users };
    if (opts.bounce) row.bounce_rate = round1(19 + seeded(i * 19 + 7) * 34);
    if (opts.goalId != null) {
      const cr = def.cr ?? round2(1.2 + seeded(i * 23 + 11) * 4.4);
      row.goal_reaches = Math.round((visits * cr) / 100);
      row.goal_conversion = cr;
    }
    return row;
  });
}

/** Конверт разреза: итоги окна + строки (+ goal_id, когда цель выбрана). */
function ymBreakdown(
  defs: YmRowDef[],
  scopeVisits: number,
  scopeUsers: number,
  opts: { bounce?: boolean; goalId?: number | null; meta?: boolean } = {},
) {
  const body: Record<string, unknown> = {
    visits_total: scopeVisits,
    users_total: scopeUsers,
    rows: ymRows(defs, scopeVisits, opts),
  };
  if (opts.goalId != null) body.goal_id = opts.goalId;
  if (opts.meta) body.meta = { sampled: false };
  return body;
}

// ── Справочники разрезов ──────────────────────────────────────────────────────────────────────
const YM_SOURCES: YmRowDef[] = [
  { id: 'organic', name: 'Переходы из поисковых систем', share: 0.41, cr: 2.6 },
  { id: 'direct', name: 'Прямые заходы', share: 0.21, cr: 3.4 },
  { id: 'social', name: 'Переходы из соцсетей', share: 0.14, cr: 1.9 },
  { id: 'referral', name: 'Переходы по ссылкам на сайтах', share: 0.09, cr: 2.1 },
  { id: 'ad', name: 'Переходы по рекламе', share: 0.07, cr: 4.7 },
  { id: 'messenger', name: 'Переходы из мессенджеров', share: 0.04, cr: 3.1 },
  { id: 'internal', name: 'Внутренние переходы', share: 0.02, cr: 0.8 },
];

const YM_DEVICES: YmRowDef[] = [
  // Имена сырые (как их отдаёт API) — карточка обязана локализовать по СТАБИЛЬНОМУ id.
  { id: '2', name: 'Mobile', share: 0.58, cr: 2.2 },
  { id: '1', name: 'Desktop', share: 0.33, cr: 3.9 },
  { id: '3', name: 'Tablet', share: 0.06, cr: 1.7 },
  { id: '4', name: 'TV', share: 0.01, cr: 0.5 },
];

const YM_REFERRERS: YmRowDef[] = [
  { id: null, name: 'vc.ru', share: 0.31 },
  { id: null, name: 'habr.com', share: 0.22 },
  { id: null, name: 'dzen.ru', share: 0.17 },
  { id: null, name: 'pikabu.ru', share: 0.11 },
  { id: null, name: 'sostav.ru', share: 0.08 },
  { id: null, name: 'cossa.ru', share: 0.06 },
];

const YM_SOCIAL: YmRowDef[] = [
  { id: 'vkontakte', name: 'ВКонтакте', share: 0.47 },
  { id: 'youtube', name: 'YouTube', share: 0.21 },
  { id: 'instagram', name: 'Instagram', share: 0.16 },
  { id: 'odnoklassniki', name: 'Одноклассники', share: 0.08 },
  { id: 'pinterest', name: 'Pinterest', share: 0.05 },
];

const YM_MESSENGERS: YmRowDef[] = [
  { id: 'telegram', name: 'Telegram', share: 0.71 },
  { id: 'whatsapp', name: 'WhatsApp', share: 0.16 },
  { id: 'viber', name: 'Viber', share: 0.07 },
  { id: 'skype', name: 'Skype', share: 0.03 },
];

const YM_COUNTRIES: YmRowDef[] = [
  { id: '225', name: 'Россия', share: 0.68 },
  { id: '159', name: 'Казахстан', share: 0.11 },
  { id: '149', name: 'Беларусь', share: 0.07 },
  { id: '187', name: 'Украина', share: 0.04 },
  { id: '96', name: 'Германия', share: 0.03 },
  { id: '84', name: 'США', share: 0.02 },
  { id: '983', name: 'Армения', share: 0.02 },
];

const YM_CITIES: YmRowDef[] = [
  { id: '213', name: 'Москва', share: 0.34 },
  { id: '2', name: 'Санкт-Петербург', share: 0.16 },
  { id: '54', name: 'Екатеринбург', share: 0.07 },
  { id: '43', name: 'Казань', share: 0.06 },
  { id: '65', name: 'Новосибирск', share: 0.05 },
  { id: '47', name: 'Нижний Новгород', share: 0.04 },
  { id: '162', name: 'Алматы', share: 0.04 },
  { id: '157', name: 'Минск', share: 0.03 },
];

// Демография: имена сырые — карточка локализует по стабильному id (ageInterval / gender).
const YM_AGE: YmRowDef[] = [
  { id: '25', name: 'age_25_34', share: 0.31 },
  { id: '35', name: 'age_35_44', share: 0.24 },
  { id: '18', name: 'age_18_24', share: 0.16 },
  { id: '45', name: 'age_45_54', share: 0.09 },
  { id: '55', name: 'age_55', share: 0.04 },
  { id: '17', name: 'age_under_18', share: 0.02 },
];

// Сумма долей демографии = её покрытие (см. demographics): строки обязаны сойтись с known_visits,
// иначе сноска «определено для N% визитов» противоречила бы самому списку.
const YM_GENDER: YmRowDef[] = [
  { id: 'female', name: 'f', share: 0.56 },
  { id: 'male', name: 'm', share: 0.35 },
];

const YM_UTM: YmRowDef[] = [
  { id: 'telegram', name: 'telegram', share: 0.11, cr: 3.8 },
  { id: 'instagram', name: 'instagram', share: 0.08, cr: 2.4 },
  { id: 'yandex-direct', name: 'yandex-direct', share: 0.06, cr: 5.1 },
  { id: 'newsletter', name: 'newsletter', share: 0.03, cr: 6.2 },
  { id: 'vk-ads', name: 'vk-ads', share: 0.02, cr: 1.6 },
];

const YM_PAGES = [
  { path: '/', share: 0.24 },
  { path: '/catalog', share: 0.16 },
  { path: '/catalog/notebooks', share: 0.11 },
  { path: '/blog/kak-schitat-er', share: 0.08 },
  { path: '/delivery', share: 0.06 },
  { path: '/about', share: 0.05 },
  { path: '/blog/analitika-2026', share: 0.04 },
  { path: '/contacts', share: 0.03 },
  { path: '/catalog/audio', share: 0.03 },
  { path: '/faq', share: 0.02 },
];

const YM_LANDINGS = [
  { path: '/', share: 0.27, cr: 2.9 },
  { path: '/lp/promo', share: 0.14, cr: 6.8 },
  { path: '/catalog', share: 0.12, cr: 3.4 },
  { path: '/blog/kak-schitat-er', share: 0.09, cr: 1.2 },
  { path: '/catalog/notebooks', share: 0.07, cr: 4.1 },
  { path: '/lp/webinar', share: 0.05, cr: 7.6 },
  { path: '/delivery', share: 0.04, cr: 1.8 },
  { path: '/about', share: 0.03, cr: 0.9 },
  { path: '/blog/analitika-2026', share: 0.03, cr: 1.4 },
  { path: '/faq', share: 0.02, cr: 0.6 },
  { path: '/contacts', share: 0.02, cr: 5.2 },
  { path: '/catalog/audio', share: 0.01, cr: 2.7 },
];

const YM_EXITS = [
  { path: '/checkout/success', share: 0.18 },
  { path: '/', share: 0.15 },
  { path: '/catalog', share: 0.12 },
  { path: '/cart', share: 0.09 },
  { path: '/catalog/notebooks', share: 0.07 },
  { path: '/delivery', share: 0.05 },
  { path: '/contacts', share: 0.04 },
  { path: '/faq', share: 0.03 },
  { path: '/about', share: 0.03 },
  { path: '/blog/kak-schitat-er', share: 0.02 },
  { path: '/catalog/audio', share: 0.02 },
];

const YM_GOALS = [
  { id: '101', name: 'Добавление в корзину', rate: 6.4 },
  { id: '102', name: 'Оформление заказа', rate: 2.1 },
  { id: '103', name: 'Подписка на рассылку', rate: 1.3 },
  { id: '104', name: 'Клик по кнопке «Написать в Telegram»', rate: 0.8 },
];

/** Суточный профиль визитов: вечерний пик ~20:00 + обеденный бугор (те же веса, что у IG-online).
    Ночной фон несёт свой шум — иначе часы 0…7 выходили ПОБАЙТОВО одинаковыми и heatmap рисовал
    плоский блок клеток-близнецов вместо живого ритма. */
const HOUR_WEIGHTS = Array.from({ length: 24 }, (_, h) => {
  const evening = Math.exp(-((h - 20) ** 2) / 11);
  const midday = 0.55 * Math.exp(-((h - 13) ** 2) / 9);
  const night = 0.03 + seeded(h * 43 + 17) * 0.06;
  return evening + midday + night;
});

// ── Разрезы, режущиеся из окна ────────────────────────────────────────────────────────────────
interface YmScope {
  visits: number;
  users: number;
  pageviews: number;
}

const ymScope = (w: YmWindow): YmScope => {
  const rows = ymDays(w);
  return {
    visits: sumBy(rows, (r) => r.visits),
    users: sumBy(rows, (r) => r.users),
    pageviews: sumBy(rows, (r) => r.pageviews),
  };
};

/** Разрез-подмножество (рефералы/соцсети/мессенджеры): свой итог — доля всего трафика. */
function subsetBreakdown(defs: YmRowDef[], scope: YmScope, shareOfAll: number) {
  const visits = Math.round(scope.visits * shareOfAll);
  const users = Math.round(scope.users * shareOfAll);
  return ymBreakdown(defs, visits, users, { bounce: true, meta: true });
}

/** Демография: строки + честное покрытие (часть визитов Метрика не определяет). */
function demographics(defs: YmRowDef[], scope: YmScope, coverage: number) {
  const body = ymBreakdown(defs, scope.visits, scope.users, { bounce: true, meta: true });
  const known = Math.round(scope.visits * coverage);
  return {
    ...body,
    known_visits: known,
    unknown_visits: scope.visits - known,
    coverage_percent: round1(coverage * 100),
    // Малые группы Метрика скрывает — карточка обязана это оговорить сноской.
    contains_sensitive_data: true,
  };
}

function ymHourly(scope: YmScope) {
  const weightTotal = HOUR_WEIGHTS.reduce((a, b) => a + b, 0);
  let assigned = 0;
  const rows = HOUR_WEIGHTS.map((weight, hour) => {
    // Последний час забирает остаток, чтобы сумма строк ТОЧНО дала итог окна.
    const visits = hour === 23 ? Math.max(0, scope.visits - assigned) : Math.round((scope.visits * weight) / weightTotal);
    assigned += visits;
    return { hour, visits, users: Math.round(visits * 0.71) };
  });
  const peak = rows.reduce((best, row) => (row.visits > best.visits ? row : best), rows[0]);
  return {
    visits_total: scope.visits,
    users_total: scope.users,
    peak_hour: scope.visits > 0 ? peak.hour : null,
    rows,
    meta: { sampled: false },
  };
}

/** Топ страниц (hits-неймспейс): просмотры ≠ визиты — своя единица и свой итог. */
function ymPages(scope: YmScope) {
  return {
    pageviews_total: scope.pageviews,
    rows: YM_PAGES.map((page, i) => {
      const pageviews = Math.round(scope.pageviews * page.share);
      return { path: page.path, pageviews, users: Math.round(pageviews * (0.34 + seeded(i * 7 + 5) * 0.12)) };
    }),
  };
}

/** UTM: в строках ТОЛЬКО размеченные визиты, неразмеченные уходят честной сноской карточки. */
function ymUtm(scope: YmScope, goalId: number | null) {
  const rows = ymRows(YM_UTM, scope.visits, { goalId });
  const tagged = sumBy(rows, (r) => Number(r.visits));
  const body: Record<string, unknown> = {
    visits_total: scope.visits,
    tagged_visits: tagged,
    untagged_visits: scope.visits - tagged,
    rows,
  };
  if (goalId != null) body.goal_id = goalId;
  return body;
}

/** Ограничение топа страниц входа/выхода — тот же `limit`, что шлёт хук (10 на доске, 100 на странице). */
function limitOf(params: URLSearchParams, fallback: number): number {
  const raw = Number.parseInt(params.get('limit') ?? '', 10);
  return Number.isFinite(raw) ? Math.max(1, raw) : fallback;
}

function ymLandings(scope: YmScope, params: URLSearchParams) {
  const goalId = goalIdOf(params);
  return {
    // goal_id у страниц входа НЕ optional по контракту — null, когда цель не выбрана.
    goal_id: goalId,
    visits_total: scope.visits,
    rows: YM_LANDINGS.slice(0, limitOf(params, 10)).map((landing, i) => {
      const visits = Math.round(scope.visits * landing.share);
      const row: Record<string, unknown> = {
        path: landing.path,
        visits,
        users: Math.round(visits * (0.68 + seeded(i * 11 + 3) * 0.14)),
        bounce_rate: round1(17 + seeded(i * 17 + 9) * 38),
      };
      if (goalId != null) {
        row.goal_reaches = Math.round((visits * landing.cr) / 100);
        row.goal_conversion = landing.cr;
      }
      return row;
    }),
    meta: { sampled: false },
  };
}

function ymExits(scope: YmScope, params: URLSearchParams) {
  return {
    visits_total: scope.visits,
    rows: YM_EXITS.slice(0, limitOf(params, 10)).map((exit, i) => {
      const visits = Math.round(scope.visits * exit.share);
      return {
        path: exit.path,
        visits,
        users: Math.round(visits * (0.66 + seeded(i * 13 + 7) * 0.15)),
        bounce_rate: round1(15 + seeded(i * 23 + 5) * 42),
      };
    }),
    meta: { sampled: false },
  };
}

/** Цели: достижения за окно + конверсия ОТДЕЛЬНОЙ метрикой (CR из reaches не выводится). */
const ymGoals = (scope: YmScope) => ({
  rows: YM_GOALS.map((goal) => ({
    id: goal.id,
    name: goal.name,
    reaches: Math.round((scope.visits * goal.rate) / 100),
    conversion_rate: goal.rate,
  })),
  truncated: false,
});

/**
 * ЯМ-неймспейс демо-фикстур: путь (с query) → payload, `undefined` = не покрыто (уйдёт на сервер,
 * где неавторизованное демо получит 401 — поэтому всё, что /metrika и /metrics/ym-* реально
 * запрашивают, обязано быть перечислено здесь).
 */
export function ymDemoFixture(path: string): unknown | undefined {
  const [p, qs = ''] = path.split('?');
  const params = new URLSearchParams(qs);
  // Статус счётчика: демо-Метрика ПОДКЛЮЧЕНА — иначе /connect и орбита звали бы подключать то,
  // что уже показывает данные.
  if (p === '/api/ym/status') {
    return { connected: true, counter_name: 'Демо-счётчик', counter_id: '10000001', site: 'demo.atlavue.app' };
  }

  const w = ymWindow(params);
  if (p === '/api/ym/summary') return ymSummary(w);

  const scope = ymScope(w);
  const goalId = goalIdOf(params);
  if (p === '/api/ym/sources') return ymBreakdown(YM_SOURCES, scope.visits, scope.users, { goalId });
  if (p === '/api/ym/devices') return ymBreakdown(YM_DEVICES, scope.visits, scope.users, { bounce: true, goalId, meta: true });
  if (p === '/api/ym/referrers') return subsetBreakdown(YM_REFERRERS, scope, 0.09);
  if (p === '/api/ym/social') return subsetBreakdown(YM_SOCIAL, scope, 0.14);
  if (p === '/api/ym/messengers') return subsetBreakdown(YM_MESSENGERS, scope, 0.04);
  if (p === '/api/ym/countries') return ymBreakdown(YM_COUNTRIES, scope.visits, scope.users, { bounce: true, meta: true });
  if (p === '/api/ym/cities') return ymBreakdown(YM_CITIES, scope.visits, scope.users, { bounce: true, meta: true });
  if (p === '/api/ym/age') return demographics(YM_AGE, scope, 0.86);
  if (p === '/api/ym/gender') return demographics(YM_GENDER, scope, 0.91);
  if (p === '/api/ym/goals') return ymGoals(scope);
  if (p === '/api/ym/utm') return ymUtm(scope, goalId);
  if (p === '/api/ym/pages') return ymPages(scope);
  if (p === '/api/ym/landings') return ymLandings(scope, params);
  if (p === '/api/ym/hourly') return ymHourly(scope);
  if (p === '/api/ym/exits') return ymExits(scope, params);
  return undefined;
}
