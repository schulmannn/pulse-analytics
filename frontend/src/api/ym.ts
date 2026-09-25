import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet } from '@/api/client';
import { qk } from '@/api/queryKeys';
import { keepPreviousForChannel } from '@/api/keepPrevious';
import { STALE_LIVE, STALE_STATUS } from '@/api/policy';
import { useSelectedChannel } from '@/lib/channel-context';
import { msPeriodQuery, type MsPeriod } from '@/lib/msPeriod';

/**
 * Запросы источника «Яндекс.Метрика» — ОТДЕЛЬНЫМ модулем, по той же причине, что api/cdek,
 * api/rusender и api/ms: схемы источника не должны ехать в чанк каждого, кто импортирует
 * `api/queries`. Период у Метрики общий с МойСкладом (`msPeriodQuery`) — это ЕДИНСТВЕННОЕ, что
 * их связывает, и связь идёт через lib/msPeriod, а не через соседство в одном файле.
 */

// ── «Яндекс.Метрика» (source='ym'): сервер-агрегированные дневные отчёты счётчика ────────────
// total nullable — как и quality: null = сбора не было (пустой архив «Всё» без живого отчёта),
// а не «ноль визитов». fmt.short(null) рисует «—», канонический знак пропуска.
const YmSeriesBlockSchema = z
  .object({
    total: z.number().nullable(),
    series: z.array(z.object({ day: z.string(), value: z.number() }).passthrough()),
  })
  .passthrough();
// Качество трафика: nullable — доли/средние честно недоступны без данных (сервер не выдумывает 0).
// robot_* — явная роботность: число роботных визитов и их доля (Метрика включает роботов «по
// поведению» в трафик по умолчанию; мы их показываем, а не вычитаем молча).
const YmQualitySchema = z
  .object({
    bounce_rate: z.number().nullable(),
    avg_visit_duration_seconds: z.number().nullable(),
    page_depth: z.number().nullable(),
    new_users: z.number().nullable(),
    percent_new_visitors: z.number().nullable(),
    // optional keeps rolling deploys compatible with an older API that already returned
    // quality, but did not yet know about robot metrics.
    robot_visits: z.number().nullable().optional(),
    robot_percentage: z.number().nullable().optional(),
  })
  .passthrough();
// Дневные серии качества (аддитивно): по одной выровненной по дате серии на метрику; value
// nullable — «нет данных» честно остаётся null. Используются только тренд-спарклайнами KPI.
const YmQualityPointSchema = z.object({ day: z.string(), value: z.number().nullable() }).passthrough();
const YmQualitySeriesSchema = z
  .object({
    bounce_rate: z.array(YmQualityPointSchema),
    avg_visit_duration_seconds: z.array(YmQualityPointSchema),
    page_depth: z.array(YmQualityPointSchema),
    new_users: z.array(YmQualityPointSchema),
    percent_new_visitors: z.array(YmQualityPointSchema),
    robot_visits: z.array(YmQualityPointSchema),
    robot_percentage: z.array(YmQualityPointSchema),
  })
  .partial()
  .passthrough();
// Свежесть/сэмплирование: exact_period_totals говорит, доступны ли точные итоги периода; сэмпл/лаг-
// поля приходят ТОЛЬКО когда Reporting API их вернул (UI молчит о них, когда их нет).
const YmSummaryMetaSchema = z
  .object({
    exact_period_totals: z.boolean(),
    all_time: z.boolean().optional(),
    archive_last_day: z.string().nullable().optional(),
    sampled: z.boolean().optional(),
    sample_share: z.number().optional(),
    sample_size: z.number().optional(),
    sample_space: z.number().optional(),
    data_lag: z.number().optional(),
  })
  .passthrough();
const YmSummarySchema = z
  .object({
    visits: YmSeriesBlockSchema,
    users: YmSeriesBlockSchema,
    pageviews: YmSeriesBlockSchema,
    // Дополнены обратно-совместимо: старые потребители читают visits/users/pageviews как прежде.
    quality: YmQualitySchema.optional(),
    quality_series: YmQualitySeriesSchema.optional(),
    meta: YmSummaryMetaSchema.optional(),
  })
  .passthrough();
// goal_id и goal_* — АДДИТИВНАЯ атрибуция выбранной цели (optional/null-safe для rolling-deploy:
// старый сервер их не присылает). null = цель не выбрана или метрика не пришла; реальный 0 — это 0.
const YmSourcesSchema = z
  .object({
    goal_id: z.number().nullable().optional(),
    visits_total: z.number(),
    users_total: z.number(),
    rows: z.array(
      z
        .object({
          id: z.string().nullable(),
          name: z.string().nullable(),
          visits: z.number(),
          users: z.number(),
          goal_reaches: z.number().nullable().optional(),
          goal_conversion: z.number().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const YmStatusSchema = z
  .object({
    connected: z.boolean(),
    counter_name: z.string().nullable().optional(),
    counter_id: z.string().nullable().optional(),
    site: z.string().nullable().optional(),
  })
  .passthrough();

export function useYmStatus(channelIdOverride?: number | null) {
  const { channelId: selectedChannelId } = useSelectedChannel();
  const channelId = channelIdOverride === undefined ? selectedChannelId : channelIdOverride;
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.ymStatus.byChannel(channelId),
    staleTime: STALE_STATUS,
    retry: false,
    queryFn: ({ signal }) => apiGet('/api/ym/status', YmStatusSchema, { signal, channelId }),
  });
}

// Период Метрики сериализуется тем же feed-топбаром, что у МС (msPeriodQuery/msPeriodKey —
// сете-агностичные хелперы окна): одна система координат окон на все не-социальные источники.
export function useYmSummary(period: MsPeriod, opts?: { enabled?: boolean }) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // opts.enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: qk.ymSummary.window(channelId, period),
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/ym/summary?${msPeriodQuery(period)}`, YmSummarySchema, { signal, channelId }),
  });
}

// Общий гейт выбранной цели атрибуции: положительный safe-integer ЛИБО null. Не-цель никогда не
// попадает ни в queryKey (g0), ни в URL — сервер её всё равно отбросит числовым гейтом, но не гоняем
// зря сеть и не плодим кэш-ключей. Зеркалит серверный goalIdOf.
const ymGoalParam = (goalId: number | null): number | null =>
  goalId != null && Number.isSafeInteger(goalId) && goalId > 0 ? goalId : null;

/** Параметры разреза Метрики. Все три опциональны — семья сама решает, что из них у неё есть. */
export interface YmBreakdownParams {
  /** Выбранная цель атрибуции (источники/устройства/UTM/страницы входа); не-цель отсекает ymGoalParam. */
  goalId?: number | null;
  /** Размер топа отчёта — только у семей с limit (страницы входа/выхода). */
  limit?: number;
  /** Внешний гейт поверх канального (карточка ещё не подошла к вьюпорту); queryKey прежний. */
  enabled?: boolean;
}

/** Ключевая семья разреза из `qk` — структурный контракт, чтобы фабрика не знала про весь `qk`. */
interface YmKeyFamily {
  window: (channelId: number | null, period: MsPeriod, ...tail: number[]) => Array<string | number | boolean | null>;
}

/**
 * Фабрика хука одного разреза Метрики. 15 хуков отличались ТОЛЬКО путём, литералом семьи и
 * Zod-схемой — по 10-13 строк копипасты на каждый. Формы ключей сохранены БАЙТ-В-БАЙТ (они в проде
 * и в живых кэшах): `[семья, channelId, ...msPeriodKey(period), limit?, goal ?? 0?]`. Хвост ключа и
 * хвост query-строки идут в ОДНОМ порядке — сперва `limit`, затем `goal_id`.
 */
function ymBreakdownQuery<S extends z.ZodTypeAny>(
  family: YmKeyFamily,
  path: string,
  schema: S,
  shape: { goal?: boolean; limit?: number } = {},
) {
  return function useYmBreakdown(period: MsPeriod, params: YmBreakdownParams = {}) {
    const { channelId } = useSelectedChannel();
    const goal = shape.goal ? ymGoalParam(params.goalId ?? null) : null;
    const limit = shape.limit != null ? (params.limit ?? shape.limit) : null;
    const tail: number[] = [];
    if (limit != null) tail.push(limit);
    if (shape.goal) tail.push(goal ?? 0);
    return useQuery({
      enabled: channelId != null && params.enabled !== false,
      queryKey: family.window(channelId, period, ...tail),
      staleTime: STALE_LIVE,
      queryFn: ({ signal }) =>
        apiGet(
          `${path}?${msPeriodQuery(period)}${limit != null ? `&limit=${limit}` : ''}${goal != null ? `&goal_id=${goal}` : ''}`,
          schema,
          { signal, channelId },
        ),
    });
  };
}

export const useYmSources = ymBreakdownQuery(qk.ymSources, '/api/ym/sources', YmSourcesSchema, { goal: true });

// Слайс аудитории/источников: устройства (ym:s:deviceCategory), реферальные сайты
// (ym:s:externalRefererDomain — внешние домены, без внутренних переходов) и соцсети
// (ym:s:lastsignSocialNetwork). Единый контракт: визиты/посетители + отказы по строке (nullable —
// средняя без данных честно недоступна, не 0). meta — сэмпл/лаг только когда Reporting API их дал.
const YmBreakdownSchema = z
  .object({
    // goal_id/goal_* приходят только у разрезов с атрибуцией цели (устройства); прочие разрезы их
    // не шлют. optional/null-safe → одна схема совместима и с ними, и с rolling-deploy старого сервера.
    goal_id: z.number().nullable().optional(),
    visits_total: z.number(),
    users_total: z.number(),
    rows: z.array(
      z
        .object({
          id: z.string().nullable(),
          name: z.string().nullable(),
          visits: z.number(),
          users: z.number(),
          bounce_rate: z.number().nullable(),
          goal_reaches: z.number().nullable().optional(),
          goal_conversion: z.number().nullable().optional(),
        })
        .passthrough(),
    ),
    meta: z
      .object({
        sampled: z.boolean().optional(),
        sample_share: z.number().optional(),
        data_lag: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type YmBreakdown = z.infer<typeof YmBreakdownSchema>;

export const useYmDevices = ymBreakdownQuery(qk.ymDevices, '/api/ym/devices', YmBreakdownSchema, { goal: true });
export const useYmReferrers = ymBreakdownQuery(qk.ymReferrers, '/api/ym/referrers', YmBreakdownSchema);
export const useYmSocial = ymBreakdownQuery(qk.ymSocial, '/api/ym/social', YmBreakdownSchema);
export const useYmMessengers = ymBreakdownQuery(qk.ymMessengers, '/api/ym/messengers', YmBreakdownSchema);

// География посетителей: страны (ym:s:regionCountry) и города (ym:s:regionCity). Тот же breakdown-
// контракт (визиты/посетители + отказы по строке, стабильный id + русское имя при lang=ru), без
// атрибуции цели. Живые отчёты, общий оконный контракт 7/30/90/диапазон/«Всё».
export const useYmCountries = ymBreakdownQuery(qk.ymCountries, '/api/ym/countries', YmBreakdownSchema);
export const useYmCities = ymBreakdownQuery(qk.ymCities, '/api/ym/cities', YmBreakdownSchema);

// Демография посетителей: возраст (ym:s:ageInterval) и пол (ym:s:gender). Тот же breakdown-контракт
// (визиты/посетители + отказы по строке, стабильный id + русское имя при lang=ru), без атрибуции
// цели. Значения — оценка Метрики по поведению аудитории, не анкета; карточка это оговаривает.
const YmDemographicsSchema = YmBreakdownSchema.extend({
  known_visits: z.number(),
  unknown_visits: z.number(),
  coverage_percent: z.number().nullable(),
  contains_sensitive_data: z.boolean(),
});
export type YmDemographics = z.infer<typeof YmDemographicsSchema>;

export const useYmAge = ymBreakdownQuery(qk.ymAge, '/api/ym/age', YmDemographicsSchema);
export const useYmGender = ymBreakdownQuery(qk.ymGender, '/api/ym/gender', YmDemographicsSchema);

// Слайс 2: цели (reaches + conversionRate — отдельная метрика, из reaches не выводится),
// топ-страницы (hits-неймспейс, просмотры ≠ визиты) и utm_source-разрез с честным хвостом
// неразмеченных визитов.
const YmGoalsSchema = z
  .object({
    rows: z.array(
      z
        .object({ id: z.string(), name: z.string().nullable(), reaches: z.number(), conversion_rate: z.number() })
        .passthrough(),
    ),
    truncated: z.boolean(),
  })
  .passthrough();
const YmPagesSchema = z
  .object({
    pageviews_total: z.number(),
    rows: z.array(z.object({ path: z.string(), pageviews: z.number(), users: z.number() }).passthrough()),
  })
  .passthrough();
const YmUtmSchema = z
  .object({
    goal_id: z.number().nullable().optional(),
    visits_total: z.number(),
    tagged_visits: z.number(),
    untagged_visits: z.number(),
    rows: z.array(
      z
        .object({
          id: z.string().nullable(),
          name: z.string().nullable(),
          visits: z.number(),
          users: z.number(),
          goal_reaches: z.number().nullable().optional(),
          goal_conversion: z.number().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const useYmGoals = ymBreakdownQuery(qk.ymGoals, '/api/ym/goals', YmGoalsSchema);
export const useYmPages = ymBreakdownQuery(qk.ymPages, '/api/ym/pages', YmPagesSchema);
export const useYmUtm = ymBreakdownQuery(qk.ymUtm, '/api/ym/utm', YmUtmSchema, { goal: true });

// Слайс качества: лендинги (страницы ВХОДА — startURLPath, не PathFull) с отказами и
// опциональными достижениями/конверсией ОДНОЙ выбранной цели. goal — положительный id или null;
// сервер валидирует его числовым гейтом до сборки метрик, кэш scoped по каналу+периоду+цели.
const YmLandingsSchema = z
  .object({
    goal_id: z.number().nullable(),
    visits_total: z.number(),
    rows: z.array(
      z
        .object({
          path: z.string(),
          visits: z.number(),
          users: z.number(),
          bounce_rate: z.number().nullable(),
          goal_reaches: z.number().optional(),
          goal_conversion: z.number().nullable().optional(),
        })
        .passthrough(),
    ),
    meta: z
      .object({
        sampled: z.boolean().optional(),
        sample_share: z.number().optional(),
        data_lag: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type YmLandings = z.infer<typeof YmLandingsSchema>;

/** Топ страниц входа. `goalId` (положительный id или null — общий гейт ymGoalParam) добавляет
    достижения/конверсию цели; вместе с `limit` входит в queryKey и в query-строку — переключение
    цели рефетчит, но не плодит ключей вне цели. */
export const useYmLandings = ymBreakdownQuery(qk.ymLandings, '/api/ym/landings', YmLandingsSchema, {
  goal: true,
  limit: 10,
});

// Слайс ритма/выходов: распределение визитов по часу суток (ym:s:hour — суточный профиль, всегда
// 24 плотные строки 0..23 + пик) и страницы выхода (ym:s:endURLPath — зеркало входов, БЕЗ атрибуции
// цели). Оба — живые отчёты, тот же оконный контракт 7/30/90/диапазон/«Всё».
const YmHourlySchema = z
  .object({
    visits_total: z.number(),
    users_total: z.number(),
    // Час пика суток (0..23) — null, когда за окно не было визитов (ложный «пик в 0:00» не рисуем).
    peak_hour: z.number().nullable(),
    rows: z.array(z.object({ hour: z.number(), visits: z.number(), users: z.number() }).passthrough()),
    meta: z
      .object({ sampled: z.boolean().optional(), sample_share: z.number().optional(), data_lag: z.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type YmHourly = z.infer<typeof YmHourlySchema>;

export const useYmHourly = ymBreakdownQuery(qk.ymHourly, '/api/ym/hourly', YmHourlySchema);

// Страницы выхода — зеркало лендингов (путь + визиты/посетители + отказы), но без полей цели.
const YmExitsSchema = z
  .object({
    visits_total: z.number(),
    rows: z.array(
      z
        .object({ path: z.string(), visits: z.number(), users: z.number(), bounce_rate: z.number().nullable() })
        .passthrough(),
    ),
    meta: z
      .object({ sampled: z.boolean().optional(), sample_share: z.number().optional(), data_lag: z.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type YmExits = z.infer<typeof YmExitsSchema>;

export const useYmExits = ymBreakdownQuery(qk.ymExits, '/api/ym/exits', YmExitsSchema, { limit: 10 });

const MsBackfillStatusSchema = z
  .object({
    status: z.string(),
    fetched: z.number(),
    total: z.number().nullable().optional(),
    cursor_month: z.string().nullable().optional(),
    orders_in_db: z.number().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();
type MsBackfillStatus = z.infer<typeof MsBackfillStatusSchema>;

export function useMsBackfillStatus(enabled: boolean, pollAnyway = false) {
  const { channelId } = useSelectedChannel();
  // Явные дженерики обязательны: inline-refetchInterval, читающий query.state.data,
  // зацикливает вывод TQueryFnData и схлопывает тип данных в {}.
  return useQuery<MsBackfillStatus, Error>({
    enabled: enabled && channelId != null,
    queryKey: qk.msBackfill.byChannel(channelId),
    retry: false,
    // Живой прогресс: опрос каждые 2с пока история грузится ИЛИ пока вызывающий ждёт старта
    // (pollAnyway): движок пишет running-строку только ПОСЛЕ живой оценки объёма (~секунда),
    // и без внешнего толчка интервал не завёлся бы вовсе — кнопка выглядела мёртвой (прод-фидбек).
    refetchInterval: (query) => (pollAnyway || query.state.data?.status === 'running' ? 2000 : false),
    queryFn: ({ signal }) => apiGet('/api/ms/backfill-status', MsBackfillStatusSchema, { signal, channelId }),
  });
}
