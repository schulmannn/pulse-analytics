'use strict';

const { toMetricNumber } = require('../lib/metricNumber');
const { buildMsRfm, buildMsRfmCustomers } = require('../domain/msRfm');

/**
 * АГРЕГАТЫ АРХИВА ЗАКАЗОВ МОЙСКЛАДА — отдельным репозиторием (аудит #554, бэклог долга §9).
 *
 * Полоса занимала 453 строки из 953 в `analyticsRepo` — почти половину файла, к которому за
 * дневной историей TG и IG ходит весь остальной сервер. Общего у неё с соседями не было ничего,
 * кроме пула: своя таблица (`ms_orders`), свои CTE, свой валидатор дня, своя денежная единица
 * (копейки). Поэтому она уезжает целиком, а не разрезается.
 *
 * Гейт доступа НЕ переизобретается: фабрика `gated` приходит из `analyticsRepo` тем же объектом,
 * которым пользуются его собственные ридеры (#604). Иначе на второй же копии правило разошлось бы.
 *
 * Форма вызовов не меняется: `analyticsRepo` разворачивает возвращённый объект в свой, и фасад
 * `db.js` видит ровно те же имена.
 */

const numifyMetrics = (row, keys) => {
  const out = { ...row };
  for (const k of keys) out[k] = toMetricNumber(out[k]);
  return out;
};

/**
 * @param {object} deps
 * @param {object} deps.pool пул Postgres.
 * @param {boolean} deps.enabled выключенная БД — ридеры отдают пустое, как и у соседей.
 * @param {Function} deps.gated фабрика actor-gated ридера из analyticsRepo.
 * @param {Function} deps.LIST пустое значение «список».
 * @param {Function} deps.NONE пустое значение «одиночка».
 */
function createMsAnalyticsRepo({ pool, enabled, gated, LIST, NONE }) {
  // ── Агрегаты архива заказов МойСклада (ms_orders, слайс 3) ─────────────────────────────────────
  // Общие правила блока: все чтения — по одному channel_id (tenant-ключ в каждом запросе); окно —
  // только нижняя граница sinceDay ('YYYY-MM-DD' | null = вся история), провалидированная здесь же
  // (repo не доверяет вызывающему). Календарный день/месяц = date-part moment БЕЗ tz-конверсий:
  // moment хранит МС-локальное время «как UTC» (процесс и БД — UTC, Railway-канон), поэтому
  // date_trunc/to_char по нему и есть календарь МойСклада. Суммы — КОПЕЙКИ (рубли — граница API);
  // bigint-суммы pg отдаёт строками → на выходе приводим к Number (toMetricNumber).
  const msDay = (v) => {
    if (typeof v !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
      ? v
      : null;
  };
  const msSinceDay = msDay;
  // Верхняя граница окна (тот же формат YYYY-MM-DD). ВКЛЮЧИТЕЛЬНАЯ по дню: SQL применяет её как
  // `moment < (untilDay + 1)`, поэтому весь день `to` попадает в окно (произвольный диапазон
  // топбара инклюзивен с обоих концов). null допустим только для внутренних all-time вызовов;
  // HTTP-периоды передают сегодняшний день и тем самым исключают будущие датированные заказы.
  const msUntilDay = msDay;

  // «Первый заказ клиента» — канон новизны для customers/cohorts: ЗА ВСЮ историю канала (не окна!).
  // DISTINCT ON (agent_id … ORDER BY moment, order_id) даёт ровно ОДНУ first-строку даже при
  // нескольких заказах в одну секунду — order_id (PK-часть) детерминированно рвёт ничью, поэтому
  // ровно один заказ агента может быть is_new. Заказы без agent_id в firsts/win не участвуют —
  // их честно считает no_agent_orders (фронт покажет сноску).
  const MS_FIRSTS_CTE = `firsts AS (
      SELECT DISTINCT ON (agent_id) agent_id, moment AS first_moment, order_id AS first_order_id
        FROM ms_orders
       WHERE channel_id=$1 AND agent_id IS NOT NULL
       ORDER BY agent_id, moment, order_id
    )`;
  const MS_WIN_CTE = `win AS (
      SELECT o.order_id, o.moment, o.sum_kopecks, o.agent_id,
             (o.order_id = f.first_order_id) AS is_new
        FROM ms_orders o
        JOIN firsts f ON f.agent_id = o.agent_id
       WHERE o.channel_id=$1 AND ($2::date IS NULL OR o.moment >= $2::date)
         AND ($3::date IS NULL OR o.moment < ($3::date + 1))
    )`;

  // Структура заказов по статусам (НЕ воронка/конверсия — истории переходов между статусами нет):
  // заказы, созданные в окне, GROUP BY последний сохранённый state_id (включая NULL — строки до миграции 030 /
  // заказы без статуса), orders DESC. Имя/цвет статуса репо НЕ знает — их мапит словарь
  // metadata/states на границе API (/api/ms/funnel), здесь только устойчивые id и числа.
  async function getMsFunnelInternal(channelId, { sinceDay = null, untilDay = null } = {}) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `SELECT state_id, COUNT(*)::int AS orders, COALESCE(SUM(sum_kopecks),0)::bigint AS sum_kopecks
         FROM ms_orders
        WHERE channel_id=$1 AND ($2::date IS NULL OR moment >= $2::date)
          AND ($3::date IS NULL OR moment < ($3::date + 1))
        GROUP BY state_id
        ORDER BY COUNT(*) DESC, state_id NULLS LAST`,
      [channelId, msSinceDay(sinceDay), msUntilDay(untilDay)]);
    return rows.map((r) => numifyMetrics(r, ['orders', 'sum_kopecks']));
  }

  // Новые vs повторные клиенты: summary + дневная серия окна. «Новый» заказ = ПЕРВЫЙ заказ этого
  // agent_id за всю историю (см. MS_FIRSTS_CTE), поэтому клиент с первым заказом ДО окна в окне —
  // повторный. repeat_ever (клиенты с ≥2 заказами за всю историю) — глобальная константа канала
  // для окна «Всё», где repeat_customers по определению 0. Серия отдаёт только дни с заказами
  // (нулевые календарные дни дозаполняет фронт — канон mentions.daily/ms_daily).
  async function getMsCustomersInternal(channelId, { sinceDay = null, untilDay = null } = {}) {
    const empty = {
      customers: 0, new_customers: 0, repeat_customers: 0, orders_new: 0, orders_repeat: 0,
      sum_new_kopecks: 0, sum_repeat_kopecks: 0, no_agent_orders: 0, repeat_ever: 0,
    };
    if (!enabled || !channelId) return { summary: { ...empty }, series: [] };
    const params = [channelId, msSinceDay(sinceDay), msUntilDay(untilDay)];
    const summaryQ = await pool.query(
      `WITH ${MS_FIRSTS_CTE}, ${MS_WIN_CTE}
       SELECT COUNT(DISTINCT w.agent_id)::int AS customers,
              COUNT(*) FILTER (WHERE w.is_new)::int AS orders_new,
              COUNT(*) FILTER (WHERE NOT w.is_new)::int AS orders_repeat,
              COALESCE(SUM(w.sum_kopecks) FILTER (WHERE w.is_new),0)::bigint AS sum_new_kopecks,
              COALESCE(SUM(w.sum_kopecks) FILTER (WHERE NOT w.is_new),0)::bigint AS sum_repeat_kopecks,
              (SELECT COUNT(*) FROM firsts f
                WHERE ($2::date IS NULL OR f.first_moment >= $2::date)
                  AND ($3::date IS NULL OR f.first_moment < ($3::date + 1)))::int AS new_customers,
              (SELECT COUNT(*) FROM ms_orders n
                WHERE n.channel_id=$1 AND n.agent_id IS NULL
                  AND ($2::date IS NULL OR n.moment >= $2::date)
                  AND ($3::date IS NULL OR n.moment < ($3::date + 1)))::int AS no_agent_orders,
              (SELECT COUNT(*) FROM (
                 SELECT 1 FROM ms_orders r
                  WHERE r.channel_id=$1 AND r.agent_id IS NOT NULL
                  GROUP BY r.agent_id HAVING COUNT(*) >= 2) rr)::int AS repeat_ever
         FROM win w`, params);
    const s = summaryQ.rows[0] || {};
    const summary = {
      customers: toMetricNumber(s.customers) || 0,
      new_customers: toMetricNumber(s.new_customers) || 0,
      // Производное здесь, а не в SQL: new_customers ⊆ customers по построению (первый заказ
      // окна сам лежит в окне), поэтому разность неотрицательна.
      repeat_customers: (toMetricNumber(s.customers) || 0) - (toMetricNumber(s.new_customers) || 0),
      orders_new: toMetricNumber(s.orders_new) || 0,
      orders_repeat: toMetricNumber(s.orders_repeat) || 0,
      sum_new_kopecks: toMetricNumber(s.sum_new_kopecks) || 0,
      sum_repeat_kopecks: toMetricNumber(s.sum_repeat_kopecks) || 0,
      no_agent_orders: toMetricNumber(s.no_agent_orders) || 0,
      repeat_ever: toMetricNumber(s.repeat_ever) || 0,
    };
    const seriesQ = await pool.query(
      `WITH ${MS_FIRSTS_CTE}, ${MS_WIN_CTE}
       SELECT to_char(w.moment,'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE w.is_new)::int AS new_orders,
              COUNT(*) FILTER (WHERE NOT w.is_new)::int AS repeat_orders,
              COALESCE(SUM(w.sum_kopecks) FILTER (WHERE w.is_new),0)::bigint AS sum_new_kopecks,
              COALESCE(SUM(w.sum_kopecks) FILTER (WHERE NOT w.is_new),0)::bigint AS sum_repeat_kopecks
         FROM win w
        GROUP BY 1 ORDER BY 1`, params);
    return {
      summary,
      series: seriesQ.rows.map((r) => ({
        day: r.day,
        new_orders: toMetricNumber(r.new_orders) || 0,
        repeat_orders: toMetricNumber(r.repeat_orders) || 0,
        sum_new_kopecks: toMetricNumber(r.sum_new_kopecks) || 0,
        sum_repeat_kopecks: toMetricNumber(r.sum_repeat_kopecks) || 0,
      })),
    };
  }

  // RFM по клиентам, у которых есть заказ в выбранном окне. SQL владеет только tenant/window-
  // агрегацией; относительные tie-safe scores и сегменты строит чистый domain helper. Recency
  // считается в календарных днях на конец окна, а заказы без agent_id исключаются явно.
  async function getMsRfmInternal(channelId, { sinceDay = null, untilDay = null, asOfDay = null } = {}) {
    if (!enabled || !channelId) return buildMsRfm([], { asOf: asOfDay || untilDay, noAgentOrders: 0 });
    const { rows } = await pool.query(
      `WITH win AS (
         SELECT agent_id, moment, sum_kopecks
           FROM ms_orders
          WHERE channel_id=$1 AND ($2::date IS NULL OR moment >= $2::date)
            AND ($3::date IS NULL OR moment < ($3::date + 1))
       ), customer_rows AS (
         SELECT agent_id, MAX(moment)::date AS last_day, COUNT(*)::int AS orders,
                COALESCE(SUM(sum_kopecks),0)::bigint AS sum_kopecks
           FROM win WHERE agent_id IS NOT NULL GROUP BY agent_id
       ), meta AS (
         SELECT COUNT(*) FILTER (WHERE agent_id IS NULL)::int AS no_agent_orders,
                to_char(COALESCE($4::date, CURRENT_DATE),'YYYY-MM-DD') AS as_of
           FROM win
       )
       SELECT c.agent_id,
              (COALESCE($4::date, CURRENT_DATE) - c.last_day)::int AS recency_days,
              c.orders, c.sum_kopecks, m.no_agent_orders, m.as_of
         FROM meta m LEFT JOIN customer_rows c ON TRUE
        ORDER BY c.agent_id NULLS LAST`,
      [channelId, msSinceDay(sinceDay), msUntilDay(untilDay), msUntilDay(asOfDay || untilDay)]);
    const first = rows[0] || {};
    const customers = rows
      .filter((row) => row.agent_id != null)
      .map((row) => numifyMetrics(row, ['recency_days', 'orders', 'sum_kopecks']));
    return buildMsRfm(customers, {
      asOf: first.as_of || asOfDay || untilDay || null,
      noAgentOrders: toMetricNumber(first.no_agent_orders) || 0,
    });
  }

  // Листинг покупателей ОДНОГО RFM-сегмента (/api/ms/rfm-customers): то же окно, что
  // getMsRfmInternal, плюс на клиента last_day (день последнего заказа окна) и city — город
  // ПОСЛЕДНЕГО заказа с непустым city (сырой btrim, без гео-нормализации — это адресный факт
  // строки, не группировка). Скоринг НЕ в SQL: scores относительны ВСЕЙ популяции окна, поэтому
  // тянем её целиком, а сегменты присваивает ТОТ ЖЕ domain-код, что у агрегата
  // (buildMsRfmCustomers ↔ buildMsRfm — parity-инвариант). Фильтр по сегменту и контрактную
  // сортировку тоже делает domain; SQL владеет только tenant/window-агрегацией.
  async function getMsRfmCustomersInternal(channelId, { sinceDay = null, untilDay = null, asOfDay = null, segment } = {}) {
    if (!enabled || !channelId) return buildMsRfmCustomers([], { segment, asOf: asOfDay || untilDay || null });
    const { rows } = await pool.query(
      `WITH win AS (
         SELECT agent_id, moment, sum_kopecks, city, order_id
           FROM ms_orders
          WHERE channel_id=$1 AND ($2::date IS NULL OR moment >= $2::date)
            AND ($3::date IS NULL OR moment < ($3::date + 1))
       ), customer_rows AS (
         SELECT agent_id, MAX(moment)::date AS last_day, COUNT(*)::int AS orders,
                COALESCE(SUM(sum_kopecks),0)::bigint AS sum_kopecks,
                -- order_id рвёт ничью заказов одной секунды (канон MS_FIRSTS_CTE) — иначе
                -- выбор города недетерминирован между запросами и кэш-перезаписями.
                (ARRAY_AGG(NULLIF(btrim(city),'') ORDER BY moment DESC, order_id DESC)
                   FILTER (WHERE NULLIF(btrim(city),'') IS NOT NULL))[1] AS city
           FROM win WHERE agent_id IS NOT NULL GROUP BY agent_id
       ), meta AS (
         SELECT to_char(COALESCE($4::date, CURRENT_DATE),'YYYY-MM-DD') AS as_of
       )
       SELECT c.agent_id,
              (COALESCE($4::date, CURRENT_DATE) - c.last_day)::int AS recency_days,
              to_char(c.last_day,'YYYY-MM-DD') AS last_day,
              c.orders, c.sum_kopecks, c.city, m.as_of
         FROM meta m LEFT JOIN customer_rows c ON TRUE
        ORDER BY c.agent_id NULLS LAST`,
      [channelId, msSinceDay(sinceDay), msUntilDay(untilDay), msUntilDay(asOfDay || untilDay)]);
    const first = rows[0] || {};
    const customers = rows
      .filter((row) => row.agent_id != null)
      .map((row) => numifyMetrics(row, ['recency_days', 'orders', 'sum_kopecks']));
    return buildMsRfmCustomers(customers, {
      segment,
      asOf: first.as_of || asOfDay || untilDay || null,
    });
  }

  // Когорты удержания + монетизация: когорта = месяц ПЕРВОГО заказа клиента, cell — сколько
  // клиентов когорты сделали ≥1 заказ в месяце cohort_month+offset (active) И их суммарная выручка
  // заказов этого месяца (revenue_kopecks — КОПЕЙКИ, как лежат в БД; в рубли конвертирует граница
  // API). SQL отдаёт плоский (cohort, activity, active, revenue), сетку собирает JS: offsets —
  // ПЛОТНО от 0 до последнего активного месяца КАНАЛА (нули между активностями честно заполнены;
  // горизонт data-driven, а не «до сегодня» — детерминирован для тестов и не плодит пустой хвост).
  // Только agent_id IS NOT NULL; окна нет — когорты по определению вся история (фронт обрежет что
  // не влезло). Возвраты СОЗНАТЕЛЬНО не вычитаются (тот же инвариант, что у ms_orders/RFM).
  async function getMsCohortsInternal(channelId) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `WITH firsts AS (
         SELECT agent_id, MIN(moment) AS first_moment
           FROM ms_orders
          WHERE channel_id=$1 AND agent_id IS NOT NULL
          GROUP BY agent_id
       )
       SELECT to_char(date_trunc('month', f.first_moment),'YYYY-MM') AS cohort_month,
              to_char(date_trunc('month', o.moment),'YYYY-MM') AS activity_month,
              COUNT(DISTINCT o.agent_id)::int AS active,
              COALESCE(SUM(o.sum_kopecks),0)::bigint AS revenue_kopecks
         FROM ms_orders o
         JOIN firsts f ON f.agent_id = o.agent_id
        WHERE o.channel_id=$1
        GROUP BY 1, 2
        ORDER BY 1, 2`, [channelId]);
    if (!rows.length) return [];
    // 'YYYY-MM' → порядковый номер месяца; offset = разница номеров (activity ≥ cohort всегда:
    // first_moment — минимум moment агента).
    const monthIdx = (ym) => {
      const [y, m] = ym.split('-').map(Number);
      return y * 12 + (m - 1);
    };
    const maxIdx = Math.max(...rows.map((r) => monthIdx(r.activity_month)));
    const byCohort = new Map();
    for (const r of rows) {
      let c = byCohort.get(r.cohort_month);
      if (!c) {
        c = { cohort_month: r.cohort_month, cells: new Map() };
        byCohort.set(r.cohort_month, c);
      }
      c.cells.set(monthIdx(r.activity_month) - monthIdx(r.cohort_month), {
        active: toMetricNumber(r.active) || 0,
        // Unsafe BIGINT must stay honest missing data, never become an invented zero.
        revenue_kopecks: toMetricNumber(r.revenue_kopecks),
      });
    }
    return Array.from(byCohort.values()).map((c) => {
      const span = maxIdx - monthIdx(c.cohort_month);
      const cells = [];
      for (let offset = 0; offset <= span; offset++) {
        const cell = c.cells.get(offset);
        cells.push({
          offset,
          active: cell?.active || 0,
          revenue_kopecks: cell ? cell.revenue_kopecks : 0,
        });
      }
      // size = active на offset 0: первый заказ каждого клиента когорты лежит в её месяце.
      return { cohort_month: c.cohort_month, size: c.cells.get(0)?.active || 0, cells };
    });
  }

  // Топ клиентов окна по сумме заказов: GROUP BY agent_id, безагентные строки не участвуют
  // (их честно считает no_agent_orders в customers). Сортировка sum DESC с детерминированным
  // tie-break (orders DESC, agent_id) — порядок стабилен между прогонами, как у top-products.
  // Имена контрагентов репо сознательно НЕ отдаёт: архивный agent_name протухает после
  // переименования в МС — актуальные имена резолвит граница API одним живым вызовом словаря.
  async function getMsTopCustomersInternal(channelId, { sinceDay = null, untilDay = null, limit = 10 } = {}) {
    if (!enabled || !channelId) return [];
    // Кэп 1..50 — repo не доверяет вызывающему (та же дисциплина, что listPosts).
    const safeLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 10));
    const { rows } = await pool.query(
      `SELECT agent_id, COUNT(*)::int AS orders, COALESCE(SUM(sum_kopecks),0)::bigint AS sum_kopecks
         FROM ms_orders
        WHERE channel_id=$1 AND agent_id IS NOT NULL AND ($2::date IS NULL OR moment >= $2::date)
          AND ($3::date IS NULL OR moment < ($3::date + 1))
        GROUP BY agent_id
        ORDER BY SUM(sum_kopecks) DESC, COUNT(*) DESC, agent_id
        LIMIT $4`,
      [channelId, msSinceDay(sinceDay), msUntilDay(untilDay), safeLimit]);
    return rows.map((r) => numifyMetrics(r, ['orders', 'sum_kopecks']));
  }

  // День старейшего заказа архива канала ('YYYY-MM-DD' | null на пустом архиве) — нижний якорь
  // честного окна «Всё» у живых оконных отчётов МС (top-products). Репо отдаёт только факт из
  // БД; округление до первого дня месяца — решение границы API, не репо.
  async function getMsOldestOrderDayInternal(channelId) {
    if (!enabled || !channelId) return null;
    const { rows } = await pool.query(
      `SELECT to_char(MIN(moment),'YYYY-MM-DD') AS day FROM ms_orders WHERE channel_id=$1`,
      [channelId]);
    return (rows[0] && rows[0].day) || null;
  }

  // Продажи по каналам сбыта (слайс 6): заказы окна GROUP BY sales_channel_id (включая NULL —
  // заказы без канала / строки до миграции 031), сумма DESC. Имя/тип канала репо НЕ знает — их
  // мапит словарь saleschannel на границе API (/api/ms/sales-by-channel), здесь только устойчивые
  // id и числа (зеркало getMsFunnel, но порядок по выручке, как у топов).
  async function getMsSalesByChannelInternal(channelId, { sinceDay = null, untilDay = null } = {}) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `SELECT sales_channel_id, COUNT(*)::int AS orders, COALESCE(SUM(sum_kopecks),0)::bigint AS sum_kopecks
         FROM ms_orders
        WHERE channel_id=$1 AND ($2::date IS NULL OR moment >= $2::date)
          AND ($3::date IS NULL OR moment < ($3::date + 1))
        GROUP BY sales_channel_id
        ORDER BY SUM(sum_kopecks) DESC, sales_channel_id NULLS LAST`,
      [channelId, msSinceDay(sinceDay), msUntilDay(untilDay)]);
    return rows.map((r) => numifyMetrics(r, ['orders', 'sum_kopecks']));
  }

  // Нормализация города доставки для группировки: срезаем ведущий префикс «г »/«г.»/«город »
  // (регистронезависимо) и обрезаем пробелы — «г Москва», «Москва», «город Москва» это ОДИН
  // город. Пустой результат → NULL (NULLIF), заказ уходит в no_city_orders. Живая форма МС
  // (shipmentAddressFull.city) именно такая: «г Каспийск», «Москва», «Moscow». Сырой город
  // движок хранит как есть — префикс режется только на чтении, чтобы правило было одно и здесь.
  const MS_CITY_NORM = `NULLIF(btrim(regexp_replace(city, '^(г|г\\.|город)\\s+', '', 'i')), '')`;

  // География доставки (слайс 6): топ городов окна по сумме заказов (город нормализован в SQL,
  // NULL/пустые отброшены — их считает no_city_orders). Плюс total_orders окна (все заказы, с
  // городом и без) — знаменатель «доли с гео» на границе API. Суммы — копейки (рубли — граница
  // API). Форма ответа — объект { rows, total_orders, no_city_orders }: total/no_city нужны роуту
  // рядом с топом, а второй узкий SELECT в той же функции дешевле отдельного repo-метода и держит
  // всю гео-логику в одном месте (repo владеет SQL, роут остаётся тонким). limit кэпуется здесь
  // (repo не доверяет вызывающему, как listPosts/top-customers).
  async function getMsGeographyInternal(channelId, { sinceDay = null, untilDay = null, limit = 15 } = {}) {
    if (!enabled || !channelId) return { rows: [], total_orders: 0, no_city_orders: 0 };
    const safeLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 15));
    const since = msSinceDay(sinceDay);
    const until = msUntilDay(untilDay);
    const topQ = await pool.query(
      `SELECT ${MS_CITY_NORM} AS city,
              COUNT(*)::int AS orders,
              COALESCE(SUM(sum_kopecks),0)::bigint AS sum_kopecks
         FROM ms_orders
        WHERE channel_id=$1 AND ($2::date IS NULL OR moment >= $2::date)
          AND ($3::date IS NULL OR moment < ($3::date + 1))
          AND ${MS_CITY_NORM} IS NOT NULL
        GROUP BY ${MS_CITY_NORM}
        ORDER BY SUM(sum_kopecks) DESC, ${MS_CITY_NORM}
        LIMIT $4`,
      [channelId, since, until, safeLimit]);
    const totalsQ = await pool.query(
      `SELECT COUNT(*)::int AS total_orders,
              COUNT(*) FILTER (WHERE ${MS_CITY_NORM} IS NULL)::int AS no_city_orders
         FROM ms_orders
        WHERE channel_id=$1 AND ($2::date IS NULL OR moment >= $2::date)
          AND ($3::date IS NULL OR moment < ($3::date + 1))`,
      [channelId, since, until]);
    const t = totalsQ.rows[0] || {};
    return {
      rows: topQ.rows.map((r) => numifyMetrics(r, ['orders', 'sum_kopecks'])),
      total_orders: toMetricNumber(t.total_orders) || 0,
      no_city_orders: toMetricNumber(t.no_city_orders) || 0,
    };
  }

  // Возвраты покупателей (архив ms_returns, миграция 032): точный оконный count/sum + дневная
  // серия. Читается вместо прежнего live salesreturn page-loop — токен не расшифровывается, к МС
  // не ходим. Суммы — КОПЕЙКИ (рубли — граница API). Серия отдаёт ТОЛЬКО дни с возвратами (фронт
  // дозаполняет календарь нулями, канон customers.series/mentions.daily). Возвраты СОЗНАТЕЛЬНО
  // считаются отдельно и из выручки/RFM заказов НЕ вычитаются.
  async function getMsReturnsInternal(channelId, { sinceDay = null, untilDay = null } = {}) {
    if (!enabled || !channelId) return { count: 0, sum_kopecks: 0, series: [] };
    const params = [channelId, msSinceDay(sinceDay), msUntilDay(untilDay)];
    // Одна SQL snapshot: totals и daily не могут разъехаться, если top-up пишет между запросами.
    const { rows } = await pool.query(
      `WITH win AS (
         SELECT moment, sum_kopecks FROM ms_returns
          WHERE channel_id=$1 AND ($2::date IS NULL OR moment >= $2::date)
            AND ($3::date IS NULL OR moment < ($3::date + 1))
       ), totals AS (
         SELECT COUNT(*)::int AS count, COALESCE(SUM(sum_kopecks),0)::bigint AS sum_kopecks FROM win
       ), daily AS (
         SELECT to_char(moment,'YYYY-MM-DD') AS day, COUNT(*)::int AS count,
                COALESCE(SUM(sum_kopecks),0)::bigint AS sum_kopecks
           FROM win GROUP BY 1
       )
       SELECT t.count AS total_count, t.sum_kopecks AS total_sum_kopecks,
              d.day, d.count, d.sum_kopecks
         FROM totals t LEFT JOIN daily d ON TRUE ORDER BY d.day NULLS LAST`, params);
    const t = rows[0] || {};
    return {
      count: toMetricNumber(t.total_count) || 0,
      sum_kopecks: toMetricNumber(t.total_sum_kopecks) || 0,
      series: rows.filter((r) => r.day != null).map((r) => ({
        day: r.day,
        count: toMetricNumber(r.count) || 0,
        sum_kopecks: toMetricNumber(r.sum_kopecks) || 0,
      })),
    };
  }

  // Дневная серия выручки/заказов, опционально ФИЛЬТРОВАННАЯ по одному каналу продаж (слайс 6в):
  // это «настроить график по источнику» из запроса владельца — та же ось salesChannel, но во
  // времени. salesChannelId=null → все каналы (итог, как summary из архива). День = date-part
  // moment БЕЗ tz-конверсий (канон MS-архива). Отдаёт ТОЛЬКО дни с заказами — фронт дозаполняет
  // календарь нулями (канон customers.series/mentions.daily). Суммы — копейки (рубли — граница API).
  // Список id каналов продаж → text[] для `= ANY(...)`, либо null (все каналы). Обратная
  // совместимость: одиночный salesChannelId (legacy-параметр слайса 6в) заворачиваем в массив.
  const msChannelIds = ({ salesChannelIds = null, salesChannelId = null } = {}) => {
    if (Array.isArray(salesChannelIds) && salesChannelIds.length) return salesChannelIds;
    if (salesChannelId) return [salesChannelId];
    return null;
  };

  async function getMsChannelSeriesInternal(channelId, opts = {}) {
    if (!enabled || !channelId) return [];
    const { sinceDay = null, untilDay = null } = opts;
    const ids = msChannelIds(opts);
    const { rows } = await pool.query(
      `SELECT to_char(moment,'YYYY-MM-DD') AS day,
              COUNT(*)::int AS orders,
              COALESCE(SUM(sum_kopecks),0)::bigint AS sum_kopecks
         FROM ms_orders
        WHERE channel_id=$1 AND ($2::date IS NULL OR moment >= $2::date)
          AND ($3::date IS NULL OR moment < ($3::date + 1))
          AND ($4::text[] IS NULL OR sales_channel_id = ANY($4::text[]))
        GROUP BY 1 ORDER BY 1`,
      [channelId, msSinceDay(sinceDay), msUntilDay(untilDay), ids]);
    return rows.map((r) => numifyMetrics(r, ['orders', 'sum_kopecks']));
  }

  // Разбивка дневной серии ПО каналам (breakdown): те же окно-границы, но GROUP BY канал+день.
  // Требует явный список id (breakdown без выбранных каналов бессмыслен) — пустой список → [].
  // Плоские строки { sales_channel_id, day, orders, sum_kopecks }; пивот в серии по каналу —
  // на границе API (роут). Порядок стабилен (канал, день) для детерминированных тестов.
  async function getMsChannelSeriesGroupedInternal(channelId, { sinceDay = null, untilDay = null, salesChannelIds = null } = {}) {
    if (!enabled || !channelId) return [];
    const ids = Array.isArray(salesChannelIds) ? salesChannelIds.filter(Boolean) : [];
    if (!ids.length) return [];
    const { rows } = await pool.query(
      `SELECT sales_channel_id,
              to_char(moment,'YYYY-MM-DD') AS day,
              COUNT(*)::int AS orders,
              COALESCE(SUM(sum_kopecks),0)::bigint AS sum_kopecks
         FROM ms_orders
        WHERE channel_id=$1 AND ($2::date IS NULL OR moment >= $2::date)
          AND ($3::date IS NULL OR moment < ($3::date + 1))
          AND sales_channel_id = ANY($4::text[])
        GROUP BY sales_channel_id, 2
        ORDER BY sales_channel_id, 2`,
      [channelId, msSinceDay(sinceDay), msUntilDay(untilDay), ids]);
    return rows.map((r) => numifyMetrics(r, ['orders', 'sum_kopecks']));
  }
  const getMsFunnelForActor = gated(getMsFunnelInternal, LIST);
  const getMsCustomersForActor = gated(getMsCustomersInternal, NONE);
  const getMsCohortsForActor = gated(getMsCohortsInternal, LIST);
  const getMsRfmForActor = gated(getMsRfmInternal, NONE);
  const getMsRfmCustomersForActor = gated(getMsRfmCustomersInternal, NONE);
  const getMsTopCustomersForActor = gated(getMsTopCustomersInternal, LIST);
  const getMsOldestOrderDayForActor = gated(getMsOldestOrderDayInternal, NONE);
  const getMsSalesByChannelForActor = gated(getMsSalesByChannelInternal, LIST);
  const getMsGeographyForActor = gated(getMsGeographyInternal, () => ({ rows: [], total_orders: 0, no_city_orders: 0 }));
  const getMsChannelSeriesForActor = gated(getMsChannelSeriesInternal, LIST);
  // null от ForActor = доступ отозван (гонка) — роут ответит 403, а не сфабрикованными нулями.
  const getMsReturnsForActor = gated(getMsReturnsInternal, NONE);
  const getMsChannelSeriesGroupedForActor = gated(getMsChannelSeriesGroupedInternal, LIST);

  return {
    getMsFunnelInternal,
    getMsCustomersInternal,
    getMsRfmInternal,
    getMsRfmCustomersInternal,
    getMsCohortsInternal,
    getMsTopCustomersInternal,
    getMsOldestOrderDayInternal,
    getMsSalesByChannelInternal,
    getMsGeographyInternal,
    getMsReturnsInternal,
    getMsChannelSeriesInternal,
    getMsChannelSeriesGroupedInternal,
    getMsFunnelForActor,
    getMsCustomersForActor,
    getMsCohortsForActor,
    getMsRfmForActor,
    getMsRfmCustomersForActor,
    getMsTopCustomersForActor,
    getMsOldestOrderDayForActor,
    getMsSalesByChannelForActor,
    getMsGeographyForActor,
    getMsChannelSeriesForActor,
    getMsReturnsForActor,
    getMsChannelSeriesGroupedForActor,
  };
}

module.exports = { createMsAnalyticsRepo };
