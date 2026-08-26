import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet, apiSend, apiUpload } from '@/api/client';
import { qk } from '@/api/queryKeys';
import { useSelectedChannel } from '@/lib/channel-context';
import { msPeriodQuery, type MsPeriod } from '@/lib/msPeriod';

/**
 * Запросы источника «СДЭК Fulfillment» — ОТДЕЛЬНЫМ модулем, а не в общем api/queries.
 *
 * queries.ts статически импортируют почти все маршруты, поэтому каждая схема в нём попадает и в
 * оболочку, и в чанк каждой метрик-страницы: гейт размера бандла честно поймал это на первой же
 * сборке (четыре бюджета сразу за потолком). Здесь модуль тянут только страница «Загрузки»
 * (ленивый чанк) и /connect — TG/IG-пользователь не платит за источник, которым не пользуется.
 */

const STALE_STATUS = 60_000;

// Отчёт импорта — не тост, а данные: он единственное место, где видно, что именно попало в базу
// и что было отвергнуто. Поэтому он проходит тот же Zod-контракт, что и остальные ответы.

const CdekImportSchema = z
  .object({
    id: z.number(),
    filename: z.string(),
    status: z.string(),
    rows_total: z.number(),
    rows_inserted: z.number(),
    rows_updated: z.number(),
    rows_rejected: z.number(),
    rows_deleted: z.number(),
    orders_total: z.number(),
    period_from: z.string().nullable(),
    period_to: z.string().nullable(),
    warnings: z.array(z.string()).default([]),
    rejected: z
      .array(z.object({ row: z.number().nullable(), order_id: z.string().nullable(), reason: z.string() }).passthrough())
      .default([]),
    error: z.string().nullable(),
    created_at: z.string().nullable(),
    finished_at: z.string().nullable(),
  })
  .passthrough();

const CdekStatusSchema = z
  .object({
    channel_id: z.number(),
    title: z.string().nullable(),
    warehouse_code: z.string().nullable(),
    tz: z.string().nullable(),
    last_import: CdekImportSchema.nullable(),
  })
  .passthrough();

const CdekImportsSchema = z.object({ imports: z.array(CdekImportSchema) }).passthrough();

/** Ответ загрузки: duplicate=true — тот же файл уже приезжал, отчёт прежний, а не новый. */
const CdekUploadSchema = z
  .object({ ok: z.boolean(), duplicate: z.boolean(), import: CdekImportSchema.nullable() })
  .passthrough();

const CdekSourceCreatedSchema = z
  .object({ ok: z.boolean(), channel_id: z.number(), title: z.string().nullable(), tz: z.string() })
  .passthrough();

// covered — залит ли день выгрузкой. Без него пустой день читается как провал продаж, хотя это
// дыра в загрузке; поле обязательное именно поэтому.
const CdekCoverageSchema = z
  .object({
    from: z.string().nullable(),
    to: z.string().nullable(),
    bounds: z
      .object({ first_day: z.string().nullable(), last_day: z.string().nullable(), orders: z.number() })
      .passthrough()
      .nullable(),
    days: z.array(
      z.object({ day: z.string(), revenue: z.number().nullable(), orders: z.number(), covered: z.boolean() }).passthrough(),
    ),
  })
  .passthrough();

export type CdekImport = z.infer<typeof CdekImportSchema>;
export type CdekCoverage = z.infer<typeof CdekCoverageSchema>;

export function useCdekStatus(channelIdOverride?: number | null) {
  const { channelId: selectedChannelId } = useSelectedChannel();
  const channelId = channelIdOverride === undefined ? selectedChannelId : channelIdOverride;
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.cdekStatus.byChannel(channelId),
    staleTime: STALE_STATUS,
    retry: false,
    queryFn: ({ signal }) => apiGet('/api/cdek/status', CdekStatusSchema, { signal, channelId }),
  });
}

export function useCdekImports() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.cdekImports.byChannel(channelId),
    retry: false,
    queryFn: ({ signal }) => apiGet('/api/cdek/imports', CdekImportsSchema, { signal, channelId }),
  });
}

export function useCdekCoverage() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.cdekCoverage.byChannel(channelId),
    retry: false,
    // days=0 — весь размах архива: календарь покрытия отвечает на вопрос «за что вообще есть
    // данные», и окно 30 дней сузило бы его до бессмыслицы.
    queryFn: ({ signal }) => apiGet('/api/cdek/coverage?days=0', CdekCoverageSchema, { signal, channelId }),
  });
}

/** Инвалидация после записи: архив вырос, покрытие изменилось, история пополнилась — все три. */
function invalidateCdek(qc: ReturnType<typeof useQueryClient>, channelId: number | null) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.cdekStatus.byChannel(channelId) }),
    qc.invalidateQueries({ queryKey: qk.cdekImports.byChannel(channelId) }),
    qc.invalidateQueries({ queryKey: qk.cdekCoverage.byChannel(channelId) }),
  ]);
}

export function useCdekUpload() {
  const qc = useQueryClient();
  const { channelId } = useSelectedChannel();
  return useMutation({
    mutationFn: (file: File) => apiUpload('/api/cdek/import', file, CdekUploadSchema, { channelId }),
    onSuccess: () => invalidateCdek(qc, channelId),
  });
}

export function useCdekReplay() {
  const qc = useQueryClient();
  const { channelId } = useSelectedChannel();
  return useMutation({
    mutationFn: (importId: number) =>
      apiSend('POST', `/api/cdek/imports/${importId}/replay`, undefined, CdekUploadSchema.partial({ duplicate: true }), { channelId }),
    onSuccess: () => invalidateCdek(qc, channelId),
  });
}

export function useCreateCdekSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; tz?: string }) =>
      apiSend('POST', '/api/cdek/sources', input, CdekSourceCreatedSchema, { channelId: null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channels }),
  });
}

// ── Оконные чтения «Обзора» ───────────────────────────────────────────────────────────────────
// Сервер отдаёт текущее И предыдущее окно в ОДНОМ ответе, поэтому здесь нет пары запросов и нет
// известной грабли фронта («prev-период с enabled:false отдаёт текущий кэш по fallback-ключу»):
// отдавать нечего, оба окна приезжают вместе.

const CdekWindowSchema = z
  .object({ days: z.number(), from: z.string().nullable(), to: z.string().nullable(), all: z.boolean() })
  .passthrough();

const CdekTotalsSchema = z
  .object({
    revenue: z.number().nullable(),
    orders: z.number(),
    items: z.number(),
    avg_check: z.number().nullable(),
    orders_all: z.number(),
    orders_cancelled: z.number(),
    orders_returned: z.number(),
    cancel_share: z.number().nullable(),
  })
  .passthrough();

const CdekSummarySchema = z
  .object({
    window: CdekWindowSchema,
    previous_window: z.object({ from: z.string().nullable(), to: z.string().nullable() }).passthrough().nullable(),
    include: z.string(),
    current: CdekTotalsSchema.nullable(),
    previous: CdekTotalsSchema.nullable(),
    bounds: z
      .object({ first_day: z.string().nullable(), last_day: z.string().nullable(), orders: z.number() })
      .passthrough()
      .nullable(),
  })
  .passthrough();

const CdekPointSchema = z
  .object({ day: z.string(), revenue: z.number().nullable(), orders: z.number(), items: z.number() })
  .passthrough();

const CdekSeriesSchema = z
  .object({
    window: CdekWindowSchema,
    grain: z.string(),
    include: z.string(),
    current: z.array(CdekPointSchema),
    previous: z.array(CdekPointSchema),
    // Приходит ТОЛЬКО при ?breakdown=<dim>: ряд, разложенный по измерению. Поле необязательное —
    // обычный ряд его не несёт, и требовать его схемой значило бы ломать все прежние ответы.
    dim: z.string().optional(),
    groups: z
      .array(z.object({ key: z.string().nullable(), points: z.array(CdekPointSchema) }).passthrough())
      .optional(),
  })
  .passthrough();

const CdekBreakdownRowSchema = z
  .object({
    key: z.string().nullable(),
    title: z.string().nullable(),
    article: z.string().nullable(),
    sku: z.string().nullable(),
    revenue: z.number().nullable(),
    orders: z.number(),
    items: z.number(),
    prev_revenue: z.number().nullable(),
    prev_orders: z.number(),
    // Разброс цены за штуку — только у разреза по товарам; null = строк в окне не было.
    price_min: z.number().nullable().optional(),
    price_median: z.number().nullable().optional(),
    price_max: z.number().nullable().optional(),
  })
  .passthrough();

const CdekFoldSchema = z
  .object({
    revenue: z.number(),
    orders: z.number(),
    items: z.number(),
    prev_revenue: z.number(),
    prev_orders: z.number(),
    groups: z.number(),
  })
  .passthrough();

const CdekBreakdownSchema = z
  .object({
    window: CdekWindowSchema,
    dim: z.string(),
    include: z.string(),
    rows: z.array(CdekBreakdownRowSchema),
    other: CdekFoldSchema.nullable(),
    total: CdekFoldSchema,
    truncated: z.boolean(),
  })
  .passthrough();

export type CdekTotals = z.infer<typeof CdekTotalsSchema>;
export type CdekPoint = z.infer<typeof CdekPointSchema>;
export type CdekBreakdownRow = z.infer<typeof CdekBreakdownRowSchema>;
export type CdekBreakdown = z.infer<typeof CdekBreakdownSchema>;

/** Что считать выручкой. По решению владельца отгруженное — уже проданное, отсюда дефолт. */
/**
 * Что считать выручкой/заказами. Три прежних режима ИЛИ явный набор статусов
 * `status:complete,delivery` — сервер нормализует и чистит его (normalizeCdekInclude), поэтому
 * один и тот же выбор всегда даёт одну строку и один ключ кэша.
 */
export type CdekInclude = 'revenue' | 'completed' | 'all' | `status:${string}`;

/**
 * Набор товаров фильтра в параметр запроса. Сортируется здесь, а не только на сервере: ключ кэша
 * строится на клиенте, и `a,b` с `b,a` иначе стали бы двумя разными записями одного и того же.
 * Пустой набор — отсутствие параметра, а не «ноль товаров».
 */
const productsParam = (products?: readonly string[]): string => {
  const picked = [...new Set(products ?? [])].filter(Boolean).sort();
  return picked.length > 0 ? `&products=${picked.map(encodeURIComponent).join(',')}` : '';
};

const channelsParam = (channels?: readonly string[]): string => {
  const picked = [...new Set(channels ?? [])].filter(Boolean).sort();
  // ИМЕННО `sales_channels`: `channel` — канал арендатора, `sales_channel` — одиночный выбор
  // ленты заказов. Путаница между первыми двумя уже роняла ленту в прод (#502).
  return picked.length > 0 ? `&sales_channels=${picked.map(encodeURIComponent).join(',')}` : '';
};

const productsKey = (products?: readonly string[]): string =>
  [...new Set(products ?? [])].filter(Boolean).sort().join(',');

export function useCdekSummary(
  period: MsPeriod,
  include: CdekInclude = 'revenue',
  products?: readonly string[],
  channels?: readonly string[],
) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.cdekSummary.window(channelId, period, include, productsKey(products), productsKey(channels)),
    retry: false,
    queryFn: ({ signal }) =>
      apiGet(
        `/api/cdek/summary?${msPeriodQuery(period)}&include=${include}${productsParam(products)}${channelsParam(channels)}`,
        CdekSummarySchema,
        { signal, channelId },
      ),
  });
}

export function useCdekSeries(
  period: MsPeriod,
  include: CdekInclude = 'revenue',
  grain?: string,
  products?: readonly string[],
  channels?: readonly string[],
  /** Разрез: ряд приходит группами вместо одной серии. */
  breakdown?: string,
) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.cdekSeries.window(channelId, period, include, grain ?? 'auto', productsKey(products), productsKey(channels), breakdown ?? ''),
    retry: false,
    queryFn: ({ signal }) =>
      apiGet(
        `/api/cdek/series?${msPeriodQuery(period)}&include=${include}${grain ? `&grain=${grain}` : ''}${productsParam(products)}${channelsParam(channels)}${breakdown ? `&breakdown=${breakdown}` : ''}`,
        CdekSeriesSchema,
        { signal, channelId },
      ),
  });
}

export function useCdekBreakdown(
  period: MsPeriod,
  dim: string,
  include: CdekInclude = 'revenue',
  limit = 12,
  products?: readonly string[],
  channels?: readonly string[],
) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.cdekBreakdown.window(channelId, period, include, dim, limit, productsKey(products), productsKey(channels)),
    retry: false,
    queryFn: ({ signal }) =>
      apiGet(
        `/api/cdek/breakdown?${msPeriodQuery(period)}&include=${include}&dim=${dim}&limit=${limit}${productsParam(products)}${channelsParam(channels)}`,
        CdekBreakdownSchema,
        { signal, channelId },
      ),
  });
}

// ── Лента заказов и ритм ──────────────────────────────────────────────────────────────────────

const CdekOrderSchema = z
  .object({
    order_id: z.string(),
    created_at: z.string().nullable(),
    status: z.string(),
    channel: z.string().nullable(),
    carrier: z.string().nullable(),
    external_order_id: z.string().nullable(),
    track_number: z.string().nullable(),
    comment: z.string().nullable(),
    amount: z.number().nullable(),
    items: z.number(),
    positions: z.number(),
  })
  .passthrough();

const CdekOrdersSchema = z
  .object({
    window: CdekWindowSchema,
    total: z.number(),
    truncated: z.boolean(),
    orders: z.array(CdekOrderSchema),
  })
  .passthrough();

const CdekHourlySchema = z
  .object({
    window: CdekWindowSchema,
    cells: z.array(z.object({ weekday: z.number(), hour: z.number(), orders: z.number() }).passthrough()),
  })
  .passthrough();

export type CdekOrder = z.infer<typeof CdekOrderSchema>;

export interface CdekOrderFilters {
  status?: string;
  channel?: string;
  q?: string;
}

export function useCdekOrders(period: MsPeriod, filters: CdekOrderFilters = {}, include: CdekInclude = 'revenue') {
  const { channelId } = useSelectedChannel();
  const query = new URLSearchParams(msPeriodQuery(period));
  query.set('include', include);
  if (filters.status) query.set('status', filters.status);
  // ИМЕННО `sales_channel`: `channel` — это канал арендатора (склад), и сервер разбирает его
  // раньше фильтра. Пока имена совпадали, выбор «ЯМ» уводил запрос на чужой канал и лента
  // отвечала «Не удалось получить заказы».
  if (filters.channel) query.set('sales_channel', filters.channel);
  if (filters.q) query.set('q', filters.q);
  const serialized = query.toString();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.cdekOrders.window(channelId, period, include, filters.status ?? '', filters.channel ?? '', filters.q ?? ''),
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/cdek/orders?${serialized}`, CdekOrdersSchema, { signal, channelId }),
  });
}

export function useCdekHourly(period: MsPeriod, include: CdekInclude = 'revenue') {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.cdekHourly.window(channelId, period, include),
    retry: false,
    queryFn: ({ signal }) =>
      apiGet(`/api/cdek/hourly?${msPeriodQuery(period)}&include=${include}`, CdekHourlySchema, { signal, channelId }),
  });
}
