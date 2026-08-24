import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet, apiSend, apiUpload } from '@/api/client';
import { qk } from '@/api/queryKeys';
import { useSelectedChannel } from '@/lib/channel-context';

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
