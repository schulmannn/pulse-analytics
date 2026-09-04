import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet } from '@/api/client';
import { qk } from '@/api/queryKeys';
import { keepPreviousForChannel } from '@/api/keepPrevious';
import { STALE_ARCHIVE, STALE_LIVE, STALE_STATUS } from '@/api/policy';
import { useSelectedChannel } from '@/lib/channel-context';
import { msPeriodQuery, type MsPeriod } from '@/lib/msPeriod';

/**
 * Запросы источника «МойСклад» — ОТДЕЛЬНЫМ модулем, по той же причине, что api/cdek и
 * api/rusender: `api/queries` статически импортируют почти все маршруты, поэтому каждая схема в
 * нём попадает и в оболочку, и в чанк каждой метрик-страницы. Здесь МойСклад тянут только его
 * собственные панели, /connect и резолвер виджетов — пользователь TG/IG за него не платит.
 *
 * Полоса была РАЗОРВАНА: часть отчётов жила в queries.ts выше Метрики, часть — на 400 строк ниже
 * («слайс 3»), и между ними стоял чужой источник. Здесь они рядом.
 */

// ── «МойСклад» (source='ms'): сервер-агрегированные отчёты, все суммы уже в РУБЛЯХ ──────────
const MsRevenuePointSchema = z.object({ day: z.string(), value: z.number() }).passthrough();
const MsOrdersPointSchema = z.object({ day: z.string(), sum: z.number(), count: z.number() }).passthrough();
const MsSummarySchema = z
  .object({
    revenue: z.object({ total: z.number(), series: z.array(MsRevenuePointSchema) }).passthrough(),
    orders: z.object({ totalSum: z.number(), totalCount: z.number(), series: z.array(MsOrdersPointSchema) }).passthrough(),
  })
  .passthrough();
// Additive-сводка концентрации: считается сервером по ПОЛНОМУ raw-отчёту до limit. null =
// отчёт усечён/неполон (честно недоступна). Доли/маржа = null при неположительном знаменателе.
const MsTopSummarySchema = z
  .object({
    complete: z.boolean(),
    product_count: z.number(),
    top_n: z.number(),
    revenue_positive_total: z.number(),
    profit_positive_total: z.number(),
    revenue_top10_share_pct: z.number().nullable(),
    profit_top10_share_pct: z.number().nullable(),
    net_margin_pct: z.number().nullable(),
    loss_making_count: z.number(),
    loss_making_amount: z.number(),
  })
  .passthrough();
export type MsTopSummary = z.infer<typeof MsTopSummarySchema>;

// Сравнение ассортимента с предыдущим равным окном (opt-in compare=prev). Все величины уже в
// натуральной единице метрики: rub — рубли (сервер конвертировал копейки на границе), count — штуки.
// deltaPct честно null, когда предыдущая база <= 0 (ноль не даёт конечного процента, отрицательная
// прибыль не имеет однозначной процентной интерпретации). Сопоставление и вывод
// предыдущего окна — на сервере; фронт только рендерит.
const MsMoverSchema = z
  .object({
    name: z.string(),
    current: z.number(),
    previous: z.number(),
    delta: z.number(),
    deltaPct: z.number().nullable(),
  })
  .passthrough();
const MsMetricComparisonSchema = z
  .object({
    unit: z.enum(['rub', 'count']),
    gainers: z.array(MsMoverSchema),
    losers: z.array(MsMoverSchema),
    appeared: z.array(MsMoverSchema),
    disappeared: z.array(MsMoverSchema),
  })
  .passthrough();
export type MsMetricComparison = z.infer<typeof MsMetricComparisonSchema>;
const MsAssortmentComparisonSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string() }).passthrough(),
  z
    .object({
      available: z.literal(true),
      partial: z.boolean(),
      identity_fallback_count: z.number(),
      current: z.object({ from: z.string(), to: z.string() }).passthrough(),
      previous: z.object({ from: z.string(), to: z.string() }).passthrough(),
      counts: z.object({ current_only: z.number(), previous_only: z.number(), both: z.number() }).passthrough(),
      metrics: z.object({
        revenue: MsMetricComparisonSchema,
        profit: MsMetricComparisonSchema,
        units: MsMetricComparisonSchema,
      }),
      limit: z.number(),
    })
    .passthrough(),
]);
export type MsAssortmentComparison = z.infer<typeof MsAssortmentComparisonSchema>;

const MsTopProductsSchema = z
  .object({
    rows: z.array(
      z
        .object({
          name: z.string(),
          quantity: z.number(),
          revenue: z.number(),
          profit: z.number(),
          margin: z.number().nullable(),
        })
        .passthrough(),
    ),
    total: z.number().optional(),
    truncated: z.boolean().optional(),
    summary: MsTopSummarySchema.nullable().optional(),
    comparison: MsAssortmentComparisonSchema.optional(),
  })
  .passthrough();

const MsStatusSchema = z.object({ connected: z.boolean(), org_name: z.string().nullable().optional() }).passthrough();

export function useMsStatus(channelIdOverride?: number | null) {
  const { channelId: selectedChannelId } = useSelectedChannel();
  const channelId = channelIdOverride === undefined ? selectedChannelId : channelIdOverride;
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.msStatus.byChannel(channelId),
    staleTime: STALE_STATUS,
    retry: false,
    queryFn: ({ signal }) => apiGet('/api/ms/status', MsStatusSchema, { signal, channelId }),
  });
}

// ── МойСклад, слайс 3: аналитика архива заказов (все суммы уже В РУБЛЯХ с бэка) ──
const MsFunnelSchema = z
  .object({
    window_days: z.number(),
    total_orders: z.number(),
    no_state_orders: z.number(),
    no_state_sum: z.number(),
    rows: z.array(
      z
        .object({
          state_id: z.string(),
          name: z.string().nullable(),
          color: z.string().nullable(),
          orders: z.number(),
          sum: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function useMsFunnel(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.msFunnel.window(channelId, period),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/ms/funnel?${msPeriodQuery(period)}`, MsFunnelSchema, { signal, channelId }),
  });
}

const MsCustomersSchema = z
  .object({
    window_days: z.number(),
    summary: z
      .object({
        customers: z.number(),
        new_customers: z.number(),
        repeat_customers: z.number(),
        orders_new: z.number(),
        orders_repeat: z.number(),
        sum_new: z.number(),
        sum_repeat: z.number(),
        no_agent_orders: z.number(),
        repeat_ever: z.number(),
      })
      .passthrough(),
    series: z.array(
      z
        .object({
          day: z.string(),
          new_orders: z.number(),
          repeat_orders: z.number(),
          sum_new: z.number(),
          sum_repeat: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function useMsCustomers(period: MsPeriod, opts?: { enabled?: boolean }) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // opts.enabled — внешний гейт поверх канального (зеркало useMsSummary/useYmSummary).
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: qk.msCustomers.window(channelId, period),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/ms/customers?${msPeriodQuery(period)}`, MsCustomersSchema, { signal, channelId }),
  });
}

const MsRfmSchema = z
  .object({
    window_days: z.number(),
    as_of: z.string().nullable(),
    customers: z.number(),
    no_agent_orders: z.number(),
    total_orders: z.number(),
    total_sum: z.number(),
    segments: z.array(
      z
        .object({
          key: z.enum(['champions', 'loyal', 'potential', 'new', 'at_risk', 'hibernating']),
          customers: z.number(),
          orders: z.number(),
          sum: z.number(),
          average_recency_days: z.number().nullable(),
          average_frequency: z.number().nullable(),
          average_monetary: z.number().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type MsRfm = z.infer<typeof MsRfmSchema>;

export function useMsRfm(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.msRfm.window(channelId, period),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/ms/rfm?${msPeriodQuery(period)}`, MsRfmSchema, { signal, channelId }),
  });
}

// Покупатели одного RFM-сегмента — в отличие от агрегатного /api/ms/rfm это сознательный
// tenant-scoped листинг. name/address резолвит живой словарь counterparty только для строк
// страницы; при сбое словаря бэк честно отдаёт name/address = null (и не кэширует ответ).
const MsRfmCustomersSchema = z
  .object({
    window_days: z.number(),
    as_of: z.string().nullable(),
    segment: z.string(),
    // Покупателей в ЭТОМ сегменте за окно (после фильтра, до пагинации) — опора «Показать ещё».
    total_customers: z.number(),
    rows: z.array(
      z
        .object({
          agent_id: z.string(),
          name: z.string().nullable(),
          address: z.string().nullable(),
          // Контакты из того же словаря counterparty; при деградации словаря — null.
          phone: z.string().nullable(),
          email: z.string().nullable(),
          // Город ПОСЛЕДНЕГО заказа клиента с непустым city (архив ms_orders); null если нет.
          city: z.string().nullable(),
          orders: z.number(),
          sum: z.number(),
          last_day: z.string(),
          recency_days: z.number(),
          r: z.number(),
          f: z.number(),
          m: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type MsRfmCustomers = z.infer<typeof MsRfmCustomersSchema>;

/** Первая страница листинга покупателей сегмента — 50: сервер обогащает каждую страницу
    словарём контрагентов ПОСЛЕДОВАТЕЛЬНЫМИ чанками по 25, поэтому большой limit на первом
    клике = долгий скелетон (и лишний расход rate-бюджета МС). */
export const MS_RFM_CUSTOMERS_FIRST_PAGE = 50;
/** Последующие страницы («Показать ещё») — 200 (= серверный кэп MS_RFM_CUST_LIMIT_MAX):
    с виртуализацией списка (useVirtualRows) большая страница ничего не стоит рендеру, а
    сегмент из тысяч клиентов собирается в 4 раза меньшим числом кликов. 2026-07-29. */
export const MS_RFM_CUSTOMERS_PAGE = 200;

/** Размер страницы по смещению: offset однозначно задаёт limit — ключи кэша менять не нужно. */
export function msRfmCustomersLimit(offset: number): number {
  return offset === 0 ? MS_RFM_CUSTOMERS_FIRST_PAGE : MS_RFM_CUSTOMERS_PAGE;
}

/** Страница покупателей выбранного RFM-сегмента; `segment == null` — сегмент не выбран, запрос не идёт. */
export function useMsRfmSegmentCustomers(period: MsPeriod, segment: string | null, offset: number) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null && segment != null,
    queryKey: qk.msRfmCustomers.window(channelId, period, segment, offset),
    staleTime: STALE_LIVE,
    // placeholderData здесь НАМЕРЕННО нет, хотя ключ и оконный. Это ПОСТРАНИЧНЫЙ запрос: ключ
    // меняет не только период, но и offset («Показать ещё»), а страницы копятся в состоянии
    // хоста. Отдать при смене offset данные ПРЕДЫДУЩЕЙ страницы значит подсунуть накопителю ту
    // же страницу второй раз — список перестаёт расти и не доходит до порога виртуализации
    // (поймано e2e virtual-tables). Морф периода этой таблице и не нужен: она не график.
    queryFn: ({ signal }) =>
      apiGet(
        `/api/ms/rfm-customers?${msPeriodQuery(period)}&segment=${encodeURIComponent(segment ?? '')}&limit=${msRfmCustomersLimit(offset)}&offset=${offset}`,
        MsRfmCustomersSchema,
        { signal, channelId },
      ),
  });
}

/** Императивная страница ТОГО ЖЕ листинга для CSV-выгрузки сегмента. Прямой apiGet, мимо кэша
    React Query: у выгрузки свой limit, и запись её страниц под ключи интерактивного листинга
    (limit=50) подсунула бы «Показать ещё» чужие по размеру страницы. */
export function fetchMsRfmCustomersPage(
  channelId: number,
  period: MsPeriod,
  segment: string,
  limit: number,
  offset: number,
): Promise<MsRfmCustomers> {
  return apiGet(
    `/api/ms/rfm-customers?${msPeriodQuery(period)}&segment=${encodeURIComponent(segment)}&limit=${limit}&offset=${offset}`,
    MsRfmCustomersSchema,
    { channelId },
  );
}

const MsCohortsSchema = z
  .object({
    cohorts: z.array(
      z
        .object({
          cohort_month: z.string(),
          size: z.number(),
          // revenue — выручка заказов клиентов когорты в offset-месяце, В РУБЛЯХ (граница API уже
          // сконвертировала копейки). active/size сохранены для ретеншена и старых вызывающих.
          cells: z.array(z.object({ offset: z.number(), active: z.number(), revenue: z.number().nullable() }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function useMsCohorts() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.msCohorts.byChannel(channelId),
    staleTime: STALE_ARCHIVE,
    queryFn: ({ signal }) => apiGet('/api/ms/cohorts', MsCohortsSchema, { signal, channelId }),
  });
}

const MsSalesByChannelSchema = z
  .object({
    window_days: z.number(),
    total_orders: z.number(),
    no_channel_orders: z.number(),
    // Выручка заказов без канала (синтетическая строка «Без канала» на странице вклада каналов).
    no_channel_sum: z.number(),
    rows: z.array(
      z
        .object({
          sales_channel_id: z.string(),
          name: z.string().nullable(),
          type: z.string().nullable(),
          orders: z.number(),
          sum: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function useMsSalesByChannel(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.msSalesByChannel.window(channelId, period),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) =>
      apiGet(`/api/ms/sales-by-channel?${msPeriodQuery(period)}`, MsSalesByChannelSchema, { signal, channelId }),
  });
}

const MsDayPointSchema = z.object({ day: z.string(), orders: z.number(), sum: z.number() }).passthrough();
const MsChannelSeriesSchema = z
  .object({
    window_days: z.number(),
    // Echo of the selected channel ids (null = all channels aggregated).
    channels: z.array(z.string()).nullable(),
    // AGGREGATE series over the selected channels (or all) — the Steep «filter = aggregate» view.
    series: z.array(MsDayPointSchema),
    // Per-channel series, present only when Breakdown is requested; bounded server-side.
    groups: z
      .array(z.object({ sales_channel_id: z.string(), series: z.array(MsDayPointSchema) }).passthrough())
      .nullable()
      .optional(),
    // How many separate series the server rendered vs how many the caller asked for — lets the UI
    // state the limit honestly rather than silently dropping channels.
    group_limit: z.number().optional(),
    group_total: z.number().optional(),
  })
  .passthrough();
export type MsChannelSeries = z.infer<typeof MsChannelSeriesSchema>;

/** Daily revenue/orders series for the sales-channel axis. `channels` empty = all channels
    aggregated (the default). `breakdown` asks the server for per-channel series (bounded). */
export function useMsChannelSeries(period: MsPeriod, opts: { channels: string[]; breakdown: boolean }) {
  const { channelId } = useSelectedChannel();
  const channels = [...opts.channels].sort();
  const breakdown = opts.breakdown && channels.length > 0;
  const channelParam = channels.length > 0 ? `&channels=${encodeURIComponent(channels.join(','))}` : '';
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.msChannelSeries.window(channelId, period, channels.join(',') || 'all', breakdown),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) =>
      apiGet(
        `/api/ms/channel-series?${msPeriodQuery(period)}${channelParam}${breakdown ? '&breakdown=1' : ''}`,
        MsChannelSeriesSchema,
        { signal, channelId },
      ),
  });
}

const MsGeographySchema = z
  .object({
    window_days: z.number(),
    total_orders: z.number(),
    no_city_orders: z.number(),
    rows: z.array(z.object({ city: z.string(), orders: z.number(), sum: z.number() }).passthrough()),
  })
  .passthrough();

export function useMsGeography(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.msGeography.window(channelId, period),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/ms/geography?${msPeriodQuery(period)}`, MsGeographySchema, { signal, channelId }),
  });
}

const MsTopCustomersSchema = z
  .object({
    window_days: z.number(),
    rows: z.array(
      z
        .object({ agent_id: z.string(), name: z.string().nullable(), orders: z.number(), sum: z.number() })
        .passthrough(),
    ),
  })
  .passthrough();

export function useMsTopCustomers(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.msTopCustomers.window(channelId, period),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/ms/top-customers?${msPeriodQuery(period)}`, MsTopCustomersSchema, { signal, channelId }),
  });
}

const MsReturnsSchema = z
  .object({
    window_days: z.number(),
    archive_status: z.enum(['pending', 'idle', 'running', 'done', 'error']),
    complete: z.boolean(),
    archived_count: z.number(),
    total_estimate: z.number().nullable(),
    count: z.number(),
    sum: z.number(),
    // Дневная серия архива (только дни с возвратами; фронт дозаполняет календарь нулями). Сумма
    // уже в рублях. Возвраты считаются ОТДЕЛЬНО и из выручки заказов не вычитаются.
    series: z.array(z.object({ day: z.string(), count: z.number(), sum: z.number() }).passthrough()).default([]),
  })
  .passthrough();

export function useMsReturns(period: MsPeriod, opts?: { enabled?: boolean }) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // opts.enabled — внешний гейт поверх канального (зеркало useMsSummary/useMsCustomers).
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: qk.msReturns.window(channelId, period),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/ms/returns?${msPeriodQuery(period)}`, MsReturnsSchema, { signal, channelId }),
  });
}

export function useMsSummary(period: MsPeriod, opts?: { enabled?: boolean }) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // opts.enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: qk.msSummary.window(channelId, period),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/ms/summary?${msPeriodQuery(period)}`, MsSummarySchema, { signal, channelId }),
  });
}

export type MsProductSort = 'revenue' | 'profit' | 'margin';

export function useMsTopProducts(period: MsPeriod, limit = 10, sort: MsProductSort = 'revenue', enabled = true) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: enabled && channelId != null,
    queryKey: qk.msTopProducts.window(channelId, period, limit, sort),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) =>
      apiGet(`/api/ms/top-products?${msPeriodQuery(period)}&limit=${limit}&sort=${sort}`, MsTopProductsSchema, { signal, channelId }),
  });
}

/**
 * Сравнение ассортимента текущего окна с предыдущим равным (compare=prev). Отдельный хук с `enabled`-
 * гейтом, чтобы компактная карточка «Товаров» НИКОГДА не запрашивала сравнение — только полная
 * страница на вкладке «Динамика». Сервер отдаёт сразу три метрики (выручка/прибыль/штуки), поэтому
 * ключ окна-независим от выбранной метрики: переключение показателя не рефетчит и не плодит ключей.
 * `limit=1` держит легаси-rows минимальными — списки движений приходят из comparison, а не из rows.
 */
export function useMsAssortmentComparison(period: MsPeriod, enabled: boolean) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: enabled && channelId != null,
    queryKey: qk.msTopProductsCompare.window(channelId, period),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) =>
      apiGet(`/api/ms/top-products?${msPeriodQuery(period)}&limit=1&compare=prev`, MsTopProductsSchema, { signal, channelId }),
  });
}

const MsStockSchema = z
  .object({
    window_days: z.number(),
    // Сервер сортирует по срочности (days_left ASC NULLS LAST → stock ASC) и отдаёт первые
    // 200 строк; days_left=null — товар без продаж за окно («нет продаж», не бесконечность).
    rows: z.array(
      z
        .object({
          id: z.string().nullable(),
          name: z.string().nullable(),
          stock: z.number(),
          reserve: z.number(),
          days_left: z.number().nullable(),
          sold_window: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type MsStock = z.infer<typeof MsStockSchema>;
export type MsStockRow = MsStock['rows'][number];

/** Остатки «что заканчивается»: живой отчёт склада + скорость продаж выбранного окна. Окно
    ОБЯЗАНО быть конечным — «Всё» (days=0 без диапазона) сервер отвечает 400, вызывающие
    подменяют его конечным 30-дневным окном. */
export function useMsStock(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.msStock.window(channelId, period),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/ms/stock?${msPeriodQuery(period)}`, MsStockSchema, { signal, channelId }),
  });
}
