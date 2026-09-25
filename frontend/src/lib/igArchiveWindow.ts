/**
 * План окна Instagram: какое окно читает ЖИВЫЕ агрегаты Graph, а какое — АРХИВ ig_daily (OD-13).
 *
 * Owner (2026-09-25): «Od13 — не накладываем ограничения. А для инсты сделай сохранения в базу данных
 * по аналогии с тг». Архив ig_daily копят крон и догрузка истории, поэтому окно длиннее 90 дней
 * больше не упирается в живой Graph. Правило одно на все поверхности (useIgData, виджеты, резолвер):
 *
 *   • live    — пресеты 7д/30д/90д без своего периода. Хедлайны — серверные агрегаты
 *               /api/ig/insights (в т.ч. дедуплицированный reach_window), как было; OD-8 (смысл дня)
 *               ещё открыт, поэтому пресеты из архива пока не собираются;
 *   • archive — «Всё» и любой «Свой период». Числа — суммы строк архива по календарным дням окна,
 *               как у TG useHistory/inRange. Потолка с нашей стороны нет.
 *
 * Модуль чистый: ни React, ни сети — границы архива и «сейчас» приходят аргументами.
 */
import type { IgArchiveBounds } from '@/api/schemas';
import { NO_BASIS_ALL_TIME, NO_BASIS_CUSTOM_RANGE, NO_BASIS_SHORT_ARCHIVE } from '@/lib/delta';
import { dayKeyOf, isDayKey, periodLabel, type DateRange } from '@/lib/periodWindow';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Пресеты, которые отдаёт живой Graph-агрегат (сервер снапит `days` к ним). */
export const IG_LIVE_PRESETS: readonly number[] = [7, 30, 90];

export type IgWindowMode = 'live' | 'archive';
export type IgTimeframe = 'last_14_days' | 'last_30_days' | 'last_90_days';

export interface IgWindowPlan {
  mode: IgWindowMode;
  /** Границы окна (epoch ms, включительно) — для постов и графиков по моменту. */
  since: number;
  until: number;
  /** Календарные границы окна архива `YYYY-MM-DD`. `fromDay: null` — у «Всё» ещё нет ни одной точки. */
  fromDay: string | null;
  toDay: string;
  /** Длина окна для подписей: 7/30/90 у пресета, длина диапазона у своего периода, 0 у «Всё». */
  days: number;
  custom: boolean;
  /** `days` запроса /api/ig/insights: окно пресета; у архивного окна — 90 (живой хвост графиков). */
  insDays: number;
  /** Окно разбивок аудитории /api/ig/breakdowns. */
  timeframe: IgTimeframe;
  /** Почему у дельты нет базы (слот «нет базы»). */
  noBasisReason: string;
  /** Подпись окна тем же правилом, что у TG (periodLabel): «30 дн.» / «всё время» / «выбранный период». */
  label: string;
}

export interface IgWindowPlanInput {
  /** Пресет периода; 0 = «Всё». */
  days: number;
  range: DateRange | null;
  now: number;
  /** Границы архива из ответа /api/ig/history (дни с данными). */
  bounds?: IgArchiveBounds | null;
  /** Первый день среди строк архива — фолбэк, если сервер ещё не прислал bounds. */
  firstRowDay?: string | null;
  /** Первый момент живого дневного ряда — последний фолбэк «Всё» (свежее подключение, архив пуст). */
  firstLiveMs?: number | null;
}

export function isIgLiveWindow(days: number, range: DateRange | null): boolean {
  return range == null && IG_LIVE_PRESETS.includes(days);
}

function timeframeOf(days: number): IgTimeframe {
  return days === 7 ? 'last_14_days' : days === 30 ? 'last_30_days' : 'last_90_days';
}

/** План окна. Пресет → live; «Всё» и свой период → archive, без 90-дневного потолка. */
export function igWindowPlan(input: IgWindowPlanInput): IgWindowPlan {
  const { days, range, now } = input;
  const today = dayKeyOf(now, 'local');
  if (isIgLiveWindow(days, range)) {
    return {
      mode: 'live',
      since: now - days * DAY_MS,
      until: now,
      fromDay: dayKeyOf(now - (days - 1) * DAY_MS, 'local'),
      toDay: today,
      days,
      custom: false,
      insDays: days,
      timeframe: timeframeOf(days),
      noBasisReason: NO_BASIS_SHORT_ARCHIVE,
      label: periodLabel({ days, custom: false }, 'bare'),
    };
  }
  if (range) {
    // Свой период — ровно выбранные календарные дни (range — локальные полночь…конец дня).
    const fromDay = dayKeyOf(range.from, 'local');
    const toDay = dayKeyOf(range.to, 'local');
    const length = Math.max(1, Math.round((range.to - range.from) / DAY_MS));
    return {
      mode: 'archive',
      since: range.from,
      until: range.to,
      fromDay,
      toDay,
      days: length,
      custom: true,
      insDays: 90,
      timeframe: 'last_90_days',
      noBasisReason: NO_BASIS_CUSTOM_RANGE,
      label: periodLabel({ days: length, custom: true }, 'bare'),
    };
  }
  // «Всё»: от первого дня архива (bounds → первая строка → первая живая точка) до сегодня.
  const first = [input.bounds?.first_day, input.firstRowDay].find((d): d is string => isDayKey(d)) ?? null;
  const liveFirst = input.firstLiveMs != null && Number.isFinite(input.firstLiveMs)
    ? dayKeyOf(input.firstLiveMs, 'UTC')
    : null;
  const fromDay = first ?? liveFirst;
  return {
    mode: 'archive',
    since: fromDay ? Date.parse(`${fromDay}T00:00:00Z`) : now,
    until: now,
    fromDay,
    toDay: today,
    days: 0,
    custom: false,
    insDays: 90,
    timeframe: 'last_90_days',
    noBasisReason: NO_BASIS_ALL_TIME,
    label: periodLabel({ days: 0, custom: false }, 'bare'),
  };
}

/** Состояние запроса архива — ровно то, что нужно решению о живом фолбэке. */
export interface IgArchiveQueryState {
  data?: { rows?: unknown[] | null } | null;
  isError: boolean;
  isPending: boolean;
  fetchStatus: string;
}

/**
 * Архив пуст для целей окна: ответ пришёл без строк (свежее подключение, догрузка ещё не писала,
 * выключенный кил-свитч, переподключён другой аккаунт), чтение упало, либо запрос выключен (демо,
 * виджет вне вьюпорта) — тогда архивному окну нужен живой 90-дневный фолбэк. Одно правило на
 * useIgData и useIgWidgetData, чтобы «Всё» не пустело на одной поверхности и работало на другой.
 */
export function igArchiveEmpty(q: IgArchiveQueryState): boolean {
  if (q.data) return !q.data.rows?.length;
  return q.isError || (q.isPending && q.fetchStatus === 'idle');
}

/** Календарный день внутри окна плана (ключи `YYYY-MM-DD` сравниваются строкой). */
export function inPlanDays(plan: Pick<IgWindowPlan, 'fromDay' | 'toDay'>, day: string): boolean {
  if (!isDayKey(day)) return false;
  return (plan.fromDay == null || day >= plan.fromDay) && day <= plan.toDay;
}

// ── Покрытие архива: честные подписи в существующих слотах ─────────────────────────────────────

export interface IgArchiveCoverageInput {
  plan: Pick<IgWindowPlan, 'mode' | 'fromDay'>;
  bounds?: IgArchiveBounds | null;
  backfill?: { status: string; horizon_day?: string | null; reason?: string | null } | null;
  /** В окне нет ни одной точки архива — числа идут от живых дневных рядов. */
  liveFallback?: boolean;
  /** Дни архива, записанные прежним IG-аккаунтом канала (скрыты стражем идентичности). */
  hiddenDays?: number;
  fmtDay: (day: string) => string;
}

/**
 * Одна строка покрытия архива для тихой подписи (`text-2xs`, MetricDescriptor, noBasisReason).
 * Только на архивных окнах: на пресетах числа живые и оговорок не требуют.
 */
export function igArchiveCoverageNote(input: IgArchiveCoverageInput): string | null {
  const { plan, bounds, backfill, fmtDay } = input;
  if (plan.mode !== 'archive') return null;
  if (backfill?.status === 'error' && backfill.reason === 'ig_reauth') {
    return 'Догрузка истории остановлена — переподключите Instagram';
  }
  if (backfill?.status === 'error' && backfill.reason === 'ig_permission') {
    return 'Догрузка истории остановлена — у Instagram нет доступа к статистике, переподключите';
  }
  const first = bounds?.first_day ?? null;
  if (backfill && (backfill.status === 'running' || backfill.status === 'idle')) {
    return first ? `История Instagram догружается — архив пока с ${fmtDay(first)}` : 'История Instagram догружается';
  }
  // Известные границы — раньше «догружается»: окно целиком до горизонта или до начала архива при
  // завершённой (или выключенной) догрузке — это край истории, а не загрузка.
  if (backfill?.status === 'done' && backfill.horizon_day && plan.fromDay && plan.fromDay < backfill.horizon_day) {
    return `Раньше ${fmtDay(backfill.horizon_day)} Instagram данных не отдаёт`;
  }
  if (first && (plan.fromDay == null || plan.fromDay < first)) return `Архив Instagram — с ${fmtDay(first)}`;
  const hidden = input.hiddenDays ?? 0;
  if (hidden > 0) return `История прежнего аккаунта Instagram скрыта (${hidden} дн.)`;
  if (input.liveFallback) return 'История Instagram догружается';
  return null;
}

/** Подпись охвата на архивном окне: сумма дневных, уникального охвата за такой период нет. */
export const IG_REACH_DAILY_SUM_NOTE = 'Охват · сумма по дням: уникальный охват за такой период Instagram не считает';
/** Вовлечённые аккаунты — уникальная величина, по дням не складывается. */
export const IG_ENGAGED_NO_SUM_NOTE = 'Вовлечённые аккаунты за такой период не суммируются';
