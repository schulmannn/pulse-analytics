import { useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
  useYmAge,
  useYmCities,
  useYmCountries,
  useYmDevices,
  useYmExits,
  useYmGender,
  useYmGoals,
  useYmLandings,
  useYmMessengers,
  useYmPages,
  useYmReferrers,
  useYmSocial,
  useYmSources,
  useYmUtm,
  type YmBreakdownParams,
} from '@/api/queries';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { RadialShare } from '@/components/RadialShare';
import { ShareRows } from '@/components/ShareRows';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { TableSkeleton } from '@/components/ui/dataSkeleton';
import { fmt } from '@/lib/format';
import type { MsPeriod } from '@/lib/msPeriod';
import { useWidgetInView } from '@/lib/widgetViewport';

/**
 * ОДНА таблица разрезов «Яндекс.Метрики». Обзор (`/metrika`) и полностраничные отчёты
 * (`/metrics/ym-*`) рисуют одни и те же 14 разрезов, поэтому и определение у них одно: до этого
 * лесенка `isPending → скелет → isError → ErrorState → rows.length===0 → EmptyState →
 * YmBreakdownRows` была скопирована 14 раз в Обзоре и ещё 14 раз (уже через YmReportBody) на
 * страницах метрик, а `build`-колбэки были посимвольными копиями друг друга.
 *
 * ЧЕСТНОСТЬ ДАННЫХ: тексты пустых состояний, подписи строк, сноски и оговорки (сумма дневных
 * уникальных, роботность, покрытие демографии, «сравнение не рассчитывается») живут ЗДЕСЬ в
 * единственном экземпляре — расхождение между доской и страницей стало структурно невозможным.
 */

/** Локализация типов устройств по стабильному значению ym:s:deviceCategory. Reporting API может
    вернуть числовой id, а документация группировки называет строковые значения — поддерживаем оба. */
export const YM_DEVICE_LABELS: Record<string, string> = {
  '1': 'Десктоп',
  '2': 'Смартфоны',
  '3': 'Планшеты',
  '4': 'ТВ',
  desktop: 'Десктоп',
  mobile: 'Смартфоны',
  tablet: 'Планшеты',
  tv: 'ТВ',
};

/** Локализация возрастных групп по стабильному id ym:s:ageInterval (нижняя граница интервала).
    lang=ru обычно уже отдаёт русскую подпись, но по id мы даём единый продуктовый формат и не
    зависим от языка ответа API; неизвестный id падает на имя из ответа. */
export const YM_AGE_LABELS: Record<string, string> = {
  '17': 'До 18 лет',
  '18': '18–24 года',
  '25': '25–34 года',
  '35': '35–44 года',
  '45': '45–54 года',
  '55': '55 лет и старше',
};

/** Локализация пола по стабильному значению ym:s:gender (male/female), имя API — фолбэк. */
export const YM_GENDER_LABELS: Record<string, string> = {
  male: 'Мужчины',
  female: 'Женщины',
};

/** Методологическая подпись соцдема: оценочная природа, фактическое покрытие и privacy-redaction
    перечисляются отдельно. При нулевом total процент не выдумывается. */
export const demographicsFootnote = (data: {
  coverage_percent: number | null;
  contains_sensitive_data: boolean;
}): string => {
  const coverage =
    data.coverage_percent == null
      ? null
      : `определено для ${data.coverage_percent.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}% визитов`;
  const base = ['Оценка Метрики (Crypta)', coverage].filter(Boolean).join(' · ');
  return data.contains_sensitive_data
    ? `${base}. Часть данных скрыта при малой выборке.`
    : `${base}.`;
};

/** Вторичный контекст строки разреза: посетители + отказы (когда доступны). Отказы nullable —
    «—»-семантика: при null подпункт отказов просто опускается, а не превращается в «0%». */
export const breakdownNote = (users: number, bounceRate: number | null): string =>
  [
    `${fmt.num(users)} чел.`,
    bounceRate != null ? `${bounceRate.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}% отказов` : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** Контекст выбранной цели для строки разреза: конверсия (CR, %) + число достижений. Возвращает
    null, когда цель не выбрана (goalId==null) — тогда строка остаётся с базовым (визиты/отказы)
    контекстом. Конверсия/достижения nullable по отдельности: показываем то, что реально пришло. */
export const goalNote = (
  goalId: number | null | undefined,
  reaches: number | null | undefined,
  conversion: number | null | undefined,
): string | null => {
  if (goalId == null) return null;
  return (
    [
      conversion != null ? `CR ${conversion.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%` : null,
      reaches != null ? `${fmt.num(reaches)} достиж.` : null,
    ]
      .filter(Boolean)
      .join(' · ') || null
  );
};

/** Склейка базового и целевого контекста строки в одну note-строку (базовый всегда, цель — если есть). */
export const joinNote = (base: string | null, goal: string | null): string | null =>
  [base, goal].filter(Boolean).join(' · ') || null;

/** Общие строки breakdown-карточек Метрики (источники/цели/UTM/страницы): компактный топ-4 по
    value + сводный хвост «Ещё N <word> [из M]»; разворот карточки показывает ВСЕ строки отчёта.
    Бары — тихий одноцветный канон (цвет серии, не оценка), как статусы заказов у МС. */
export function YmBreakdownRows({
  rows,
  tailWord,
  unitTotal = null,
  footnote = null,
  radial = false,
}: {
  rows: Array<{ key: string; label: string; value: number; note: string | null }>;
  /** Слово хвоста в родительном падеже множественного («визитов», «достижений», «просмотров»). */
  tailWord: string;
  /** Итог ПОЛНОГО отчёта — знаменатель долей. null → падаем на сумму показанных строк. */
  unitTotal?: number | null;
  /** Приглушённая сноска под списком (усечение целей, визиты без метки). */
  footnote?: string | null;
  /** Компакт — полукольцо вместо списка (фиксированный малый набор категорий). */
  radial?: boolean;
}) {
  const expanded = useContext(ChartExpandedContext);
  // Знаменатель — итог ПОЛНОГО отчёта, когда сервер его дал: доля должна считаться от всего
  // трафика, а не от суммы показанных строк, иначе «45%» на компакте и на развороте — разные 45%.
  const total = unitTotal ?? rows.reduce((acc, r) => acc + Math.max(0, r.value), 0);
  // Полукольцо — только на компакте. Разворот остаётся полным списком: страница разреза для того
  // и открывается, и «из чего состоит целое» там уже отвечает колонка накопленного процента.
  if (radial && !expanded) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <RadialShare
            segments={rows.map((r) => ({ key: r.key, label: r.label, value: r.value }))}
            total={total}
            unitWord={tailWord}
          />
        </div>
        {/* Сноска едет и с кольцом: «определено для 82% визитов» — утверждение о полноте данных,
            а не украшение списка. Серый сегмент показывает ту же дыру, подпись её называет. */}
        {footnote != null && <p className="pt-1 text-2xs text-muted-foreground">{footnote}</p>}
      </div>
    );
  }
  return (
    <ShareRows
      rows={rows}
      total={total}
      tailWord={tailWord}
      expanded={expanded}
      cumulative={expanded}
      footnote={footnote}
    />
  );
}

// ── Тело разреза: одна лесенка состояний на все 14 ──────────────────────────────────────────────

export interface BreakdownRow {
  key: string;
  label: string;
  value: number;
  note: string | null;
}

export interface YmBuiltBreakdown {
  rows: BreakdownRow[];
  tailWord: string;
  unitTotal?: number | null;
  footnote?: string | null;
  /** Компакт рисует составное полукольцо вместо списка. Только для ФИКСИРОВАННОГО малого набора
      взаимоисключающих категорий БЕЗ построчной второй метрики: пол и возраст — да, устройства —
      нет, у них с выбранной целью в строке едут достижения и CR, а сегмент их нести не может. */
  radial?: boolean;
}

/** Структурный контракт результата useQuery — фабрике не нужен весь UseQueryResult. */
interface YmQueryState<T> {
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  error: unknown;
  data: T | undefined;
  refetch: () => void;
}

/** Тело breakdown-отчёта: pending/error/empty + строки. Развёрнутость списка решает хост через
    ChartExpandedContext (карточка Обзора — топ-4, YmReportCard страницы — весь отчёт). */
export function YmReportBody<T>({
  state,
  errorTitle,
  empty,
  build,
  skeletonRows = 6,
}: {
  state: YmQueryState<T>;
  errorTitle: string;
  empty: ReactNode;
  build: (data: T) => YmBuiltBreakdown | null;
  /** Высота скелета: доска Обзора показывает 4 строки, полностраничный отчёт — 6. */
  skeletonRows?: number;
}) {
  if (state.isPending) return <TableSkeleton rows={skeletonRows} columns={2} className="py-2" />;
  if (state.isError) {
    return (
      <ErrorState
        compact
        size="table"
        className="py-4"
        title={errorTitle}
        reason={state.error instanceof Error ? state.error.message : 'ошибка'}
        onRetry={() => state.refetch()}
        retrying={state.isFetching}
      />
    );
  }
  const built = state.data ? build(state.data) : null;
  if (!built || built.rows.length === 0) return <>{empty}</>;
  return (
    <YmBreakdownRows
      rows={built.rows}
      tailWord={built.tailWord}
      unitTotal={built.unitTotal ?? null}
      footnote={built.footnote ?? null}
      radial={built.radial ?? false}
    />
  );
}

// ── Таблица разрезов ───────────────────────────────────────────────────────────────────────────

export interface AboutDef {
  formula: string;
  included?: string;
  source: string;
}

/** Доска Обзора vs полностраничный отчёт: отличаются только высотой скелета и лимитом отчёта. */
export type YmBreakdownSurface = 'board' | 'page';

export interface YmBreakdownBodyProps {
  period: MsPeriod;
  /** Одна выбранная цель атрибуции на доску/страницу; разрезы без атрибуции её игнорируют. */
  goalId: number | null;
  surface: YmBreakdownSurface;
}

export interface YmBreakdownDef {
  /** Ключ карточки и маршрута: `ym-sources` → `/metrics/ym-sources`. */
  key: string;
  /** Заголовок карточки Обзора; он же h1 полностраничного отчёта. */
  title: string;
  /** Тихая подпись под h1 полностраничного отчёта. */
  descriptor: string;
  /** Rail «О метрике». */
  about: AboutDef;
  /** Заголовок карточки внутри полностраничного отчёта («Все источники»). */
  pageTitle: string;
  /** aria-label синхронного селектора цели; undefined — у разреза нет атрибуции. */
  goalAria?: string;
  /** Тело разреза: свой хук + общая лесенка состояний. */
  Body: (props: YmBreakdownBodyProps) => ReactElement;
}

/**
 * Собирает дефиницию разреза: хук вызывается ВНУТРИ тела карточки, а не в теле страницы, поэтому
 * (а) 17 параллельных запросов на маунт `/metrika` больше не летят из одной функции и (б) карточка
 * ниже фолда может честно отложить свой запрос до подхода к вьюпорту (useWidgetInView; на странице
 * метрики и в разворотe контекст = true, поведение прежнее).
 */
function defineYmBreakdown<T>(spec: {
  key: string;
  title: string;
  descriptor: string;
  about: AboutDef;
  pageTitle: string;
  goalAria?: string;
  errorTitle: string;
  useData: (period: MsPeriod, params: YmBreakdownParams) => YmQueryState<T>;
  /** Лимит ПОЛНОГО отчёта на странице метрики (у семей с limit); undefined — дефолт хука. */
  pageLimit?: number;
  empty: (data: T | undefined) => ReactNode;
  build: (data: T) => YmBuiltBreakdown | null;
}): YmBreakdownDef {
  return {
    key: spec.key,
    title: spec.title,
    descriptor: spec.descriptor,
    about: spec.about,
    pageTitle: spec.pageTitle,
    goalAria: spec.goalAria,
    Body: function YmBreakdownBody({ period, goalId, surface }: YmBreakdownBodyProps) {
      const inView = useWidgetInView();
      const state = spec.useData(period, {
        goalId,
        limit: surface === 'page' ? spec.pageLimit : undefined,
        enabled: inView,
      });
      return (
        <YmReportBody
          state={state}
          errorTitle={spec.errorTitle}
          empty={spec.empty(state.data)}
          build={spec.build}
          skeletonRows={surface === 'page' ? 6 : 4}
        />
      );
    },
  };
}

/** Пустое состояние демографии: EmptyState + та же методологическая сноска, что и под строками. */
const demographicsEmpty = (data: { coverage_percent: number | null; contains_sensitive_data: boolean } | undefined) => (
  <div>
    <EmptyState compact size="table" title="Демографические данные недоступны за период." />
    {data && <p className="text-2xs text-muted-foreground">{demographicsFootnote(data)}</p>}
  </div>
);

/** 14 разрезов Метрики в порядке доски Обзора. Каждый — источник правды и для карточки, и для
    полностраничного отчёта `/metrics/<key>`. */
export const YM_BREAKDOWNS: YmBreakdownDef[] = [
  defineYmBreakdown({
    key: 'ym-sources',
    title: 'Источники трафика',
    descriptor: 'Откуда пришли визиты за выбранное окно',
    about: {
      formula: 'Группировка визитов по источнику трафика (поиск/прямые/соцсети/реклама/…). Строка — визиты и посетители источника.',
      included: 'С выбранной целью строки дополняются достижениями и конверсией (CR) этой цели.',
      source: 'Отчёт визитов Метрики (ym:s:<trafficSource>).',
    },
    pageTitle: 'Все источники',
    goalAria: 'Цель для источников трафика',
    errorTitle: 'Не удалось получить источники трафика',
    useData: useYmSources,
    empty: () => <EmptyState compact size="table" title="Нет визитов за период." />,
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.id ?? r.name ?? 'unknown',
        label: r.name ?? 'Другие источники',
        value: r.visits,
        note: joinNote(`${fmt.num(r.users)} чел.`, goalNote(data.goal_id, r.goal_reaches, r.goal_conversion)),
      })),
      tailWord: 'визитов',
      unitTotal: data.visits_total,
    }),
  }),

  // Реферальные сайты: внешние домены (externalRefererDomain) — визиты + отказы по строке.
  defineYmBreakdown({
    key: 'ym-referrers',
    title: 'Реферальные сайты',
    descriptor: 'Внешние домены, приводящие трафик по ссылкам',
    about: {
      formula: 'Группировка визитов по внешнему домену-источнику перехода. Строка — визиты и отказы домена.',
      source: 'Отчёт визитов Метрики (ym:s:externalRefererDomain).',
    },
    pageTitle: 'Все домены',
    errorTitle: 'Не удалось получить реферальные сайты',
    useData: useYmReferrers,
    empty: () => (
      <EmptyState
        compact
        size="table"
        title="Реферальных переходов за период нет."
        reason="Здесь появятся внешние сайты, приводящие трафик по ссылкам."
      />
    ),
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.name ?? r.id ?? 'unknown',
        label: r.name ?? r.id ?? 'домен',
        value: r.visits,
        note: breakdownNote(r.users, r.bounce_rate),
      })),
      tailWord: 'визитов',
      unitTotal: data.visits_total,
    }),
  }),

  // Соцсети: конкретные сети (lastsignSocialNetwork) — визиты + отказы по строке.
  defineYmBreakdown({
    key: 'ym-social',
    title: 'Соцсети',
    descriptor: 'Конкретные соцсети, приводящие трафик',
    about: {
      formula: 'Группировка визитов из соцсетей по конкретной сети. Строка — визиты и отказы сети.',
      source: 'Отчёт визитов Метрики (ym:s:lastsignSocialNetwork).',
    },
    pageTitle: 'Все соцсети',
    errorTitle: 'Не удалось получить соцсети',
    useData: useYmSocial,
    empty: () => (
      <EmptyState
        compact
        size="table"
        title="Переходов из соцсетей за период нет."
        reason="Здесь появятся конкретные соцсети, приводящие трафик."
      />
    ),
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.id ?? r.name ?? 'unknown',
        label: r.name ?? r.id ?? 'соцсеть',
        value: r.visits,
        note: breakdownNote(r.users, r.bounce_rate),
      })),
      tailWord: 'визитов',
      unitTotal: data.visits_total,
    }),
  }),

  // Мессенджеры: отдельная размерность Метрики — Telegram не теряется внутри «Соцсетей».
  defineYmBreakdown({
    key: 'ym-messengers',
    title: 'Мессенджеры',
    descriptor: 'Telegram и другие мессенджеры — отдельная размерность, не внутри «Соцсетей»',
    about: {
      formula: 'Группировка визитов из мессенджеров по конкретному мессенджеру. Строка — визиты и отказы.',
      source: 'Отчёт визитов Метрики (ym:s:<messenger>).',
    },
    pageTitle: 'Все мессенджеры',
    errorTitle: 'Не удалось получить мессенджеры',
    useData: useYmMessengers,
    empty: () => (
      <EmptyState
        compact
        size="table"
        title="Переходов из мессенджеров за период нет."
        reason="Здесь появятся Telegram и другие мессенджеры, приводящие трафик."
      />
    ),
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.id ?? r.name ?? 'unknown',
        label: r.name ?? r.id ?? 'мессенджер',
        value: r.visits,
        note: breakdownNote(r.users, r.bounce_rate),
      })),
      tailWord: 'визитов',
      unitTotal: data.visits_total,
    }),
  }),

  // Устройства: тип устройства (deviceCategory) — локализация по стабильному id, имя — фолбэк.
  defineYmBreakdown({
    key: 'ym-devices',
    title: 'Устройства',
    descriptor: 'Типы устройств посетителей за выбранное окно',
    about: {
      formula: 'Группировка визитов по типу устройства (десктоп/смартфон/планшет/ТВ). Строка — визиты и отказы.',
      included: 'Тип локализуется по стабильному id категории; с выбранной целью строки дополняются достижениями и CR.',
      source: 'Отчёт визитов Метрики (ym:s:deviceCategory).',
    },
    pageTitle: 'Все устройства',
    goalAria: 'Цель для устройств',
    errorTitle: 'Не удалось получить устройства',
    useData: useYmDevices,
    empty: () => <EmptyState compact size="table" title="Нет визитов за период." />,
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.id ?? r.name ?? 'unknown',
        label: (r.id != null ? YM_DEVICE_LABELS[r.id] : undefined) ?? r.name ?? 'Другие устройства',
        value: r.visits,
        note: joinNote(breakdownNote(r.users, r.bounce_rate), goalNote(data.goal_id, r.goal_reaches, r.goal_conversion)),
      })),
      tailWord: 'визитов',
      unitTotal: data.visits_total,
    }),
  }),

  // Страны: география посетителей (regionCountry) — визиты + отказы по строке, имя lang=ru.
  defineYmBreakdown({
    key: 'ym-countries',
    title: 'Страны',
    descriptor: 'География посетителей по странам за выбранное окно',
    about: {
      formula: 'Группировка визитов по стране визита. Строка — визиты и отказы страны.',
      included: 'География определяется Метрикой по данным визита, а не по GPS.',
      source: 'Отчёт визитов Метрики (ym:s:regionCountry, lang=ru).',
    },
    pageTitle: 'Все страны',
    errorTitle: 'Не удалось получить страны',
    useData: useYmCountries,
    empty: () => <EmptyState compact size="table" title="Нет визитов за период." />,
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.id ?? r.name ?? 'unknown',
        label: r.name ?? r.id ?? 'страна',
        value: r.visits,
        note: breakdownNote(r.users, r.bounce_rate),
      })),
      tailWord: 'визитов',
      unitTotal: data.visits_total,
      footnote: 'География определяется Метрикой по данным визита, а не по GPS.',
    }),
  }),

  // Города: география посетителей (regionCity) — отдельная от страны размерность.
  defineYmBreakdown({
    key: 'ym-cities',
    title: 'Города',
    descriptor: 'География посетителей по городам за выбранное окно',
    about: {
      formula: 'Группировка визитов по городу визита — отдельная от страны размерность. Строка — визиты и отказы.',
      included: 'География определяется Метрикой по данным визита, а не по GPS.',
      source: 'Отчёт визитов Метрики (ym:s:regionCity, lang=ru).',
    },
    pageTitle: 'Все города',
    errorTitle: 'Не удалось получить города',
    useData: useYmCities,
    empty: () => <EmptyState compact size="table" title="Нет визитов за период." />,
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.id ?? r.name ?? 'unknown',
        label: r.name ?? r.id ?? 'город',
        value: r.visits,
        note: breakdownNote(r.users, r.bounce_rate),
      })),
      tailWord: 'визитов',
      unitTotal: data.visits_total,
    }),
  }),

  // Возраст: демография посетителей (ageInterval) — локализация по стабильному id, имя — фолбэк.
  defineYmBreakdown({
    key: 'ym-age',
    title: 'Возраст',
    descriptor: 'Возрастные группы посетителей — оценка Метрики (Crypta)',
    about: {
      formula: 'Группировка визитов по возрастной группе посетителя. Строка — визиты и отказы группы.',
      included: 'Значения — оценка Метрики по поведению аудитории, не анкета; при малой выборке часть данных скрыта.',
      source: 'Отчёт визитов Метрики (ym:s:ageInterval).',
    },
    pageTitle: 'Все возрастные группы',
    errorTitle: 'Не удалось получить возраст',
    useData: useYmAge,
    empty: demographicsEmpty,
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.id ?? r.name ?? 'unknown',
        label: (r.id != null ? YM_AGE_LABELS[r.id] : undefined) ?? r.name ?? 'возраст неизвестен',
        value: r.visits,
        note: breakdownNote(r.users, r.bounce_rate),
      })),
      tailWord: 'визитов',
      unitTotal: data.visits_total,
      radial: true,
      footnote: demographicsFootnote(data),
    }),
  }),

  // Пол: демография посетителей (gender) — локализация по стабильному id male/female.
  defineYmBreakdown({
    key: 'ym-gender',
    title: 'Пол',
    descriptor: 'Пол посетителей — оценка Метрики (Crypta)',
    about: {
      formula: 'Группировка визитов по полу посетителя. Строка — визиты и отказы группы.',
      included: 'Значения — оценка Метрики по поведению аудитории, не анкета; при малой выборке часть данных скрыта.',
      source: 'Отчёт визитов Метрики (ym:s:gender).',
    },
    pageTitle: 'По полу',
    errorTitle: 'Не удалось получить пол',
    useData: useYmGender,
    empty: demographicsEmpty,
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.id ?? r.name ?? 'unknown',
        label: (r.id != null ? YM_GENDER_LABELS[r.id] : undefined) ?? r.name ?? 'не определён',
        value: r.visits,
        note: breakdownNote(r.users, r.bounce_rate),
      })),
      tailWord: 'визитов',
      unitTotal: data.visits_total,
      radial: true,
      footnote: demographicsFootnote(data),
    }),
  }),

  // Цели: reaches за окно + конверсия отдельной метрикой (CR не выводится из reaches).
  defineYmBreakdown({
    key: 'ym-goals',
    title: 'Цели',
    descriptor: 'Достижения целей и конверсия за выбранное окно',
    about: {
      formula: 'Достижения (reaches) каждой цели за окно; конверсия (CR) — отдельная метрика Метрики, из reaches не выводится.',
      source: 'Отчёт целей Метрики (goal reaches + conversionRate).',
    },
    pageTitle: 'Все цели',
    errorTitle: 'Не удалось получить цели',
    useData: useYmGoals,
    empty: () => (
      <EmptyState
        compact
        size="table"
        title="На счётчике нет целей."
        reason="Настройте цели в Яндекс.Метрике — конверсии появятся здесь."
      />
    ),
    build: (data) => ({
      rows: data.rows.map((g) => ({
        key: g.id,
        label: g.name ?? `Цель ${g.id}`,
        value: g.reaches,
        // Конверсия — не знаковая дельта (fmt.pct) и не целое (fmt.num): доли процента
        // значимы, локаль ru даёт запятую.
        note: `CR ${g.conversion_rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%`,
      })),
      tailWord: 'достижений',
      footnote: data.truncated ? 'Показаны первые 20 целей счётчика.' : null,
    }),
  }),

  // UTM: только размеченные визиты в строках; неразмеченные — честной сноской, не строкой.
  defineYmBreakdown({
    key: 'ym-utm',
    title: 'UTM-метки',
    descriptor: 'Размеченные визиты по utm_source за выбранное окно',
    about: {
      formula: 'Группировка размеченных визитов по utm_source. Неразмеченные визиты — честной сноской, не строкой.',
      included: 'С выбранной целью строки дополняются достижениями и конверсией (CR) этой цели.',
      source: 'Отчёт визитов Метрики (ym:s:<UTMSource>).',
    },
    pageTitle: 'Все UTM-источники',
    goalAria: 'Цель для UTM-меток',
    errorTitle: 'Не удалось получить UTM-разметку',
    useData: useYmUtm,
    empty: () => (
      <EmptyState
        compact
        size="table"
        title="UTM-меток за период нет."
        reason="Размечайте ссылки в постах utm_source — источники появятся здесь."
      />
    ),
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.id ?? r.name ?? 'unknown',
        label: r.name ?? r.id ?? 'utm',
        value: r.visits,
        note: joinNote(`${fmt.num(r.users)} чел.`, goalNote(data.goal_id, r.goal_reaches, r.goal_conversion)),
      })),
      tailWord: 'визитов',
      unitTotal: data.tagged_visits,
      footnote:
        data.untagged_visits > 0
          ? `Без метки — ${fmt.num(data.untagged_visits)} визитов из ${fmt.num(data.visits_total)}.`
          : null,
    }),
  }),

  // Топ-страницы: hits-отчёт (просмотры страниц ≠ визиты — другая единица, чем сверху).
  defineYmBreakdown({
    key: 'ym-pages',
    title: 'Топ-страницы',
    descriptor: 'Самые просматриваемые страницы за выбранное окно',
    about: {
      formula: 'Группировка ПРОСМОТРОВ страниц по пути. Просмотры — hits-метрика, не визиты (другая единица).',
      source: 'Отчёт просмотров Метрики (ym:pv:URLPath).',
    },
    pageTitle: 'Все страницы',
    errorTitle: 'Не удалось получить страницы',
    useData: useYmPages,
    empty: () => <EmptyState compact size="table" title="Нет просмотров за период." />,
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.path,
        label: r.path,
        value: r.pageviews,
        note: `${fmt.num(r.users)} чел.`,
      })),
      tailWord: 'просмотров',
      unitTotal: data.pageviews_total,
    }),
  }),

  // Страницы входа (startURLPath): визиты + отказы, опц. конверсия выбранной цели.
  defineYmBreakdown({
    key: 'ym-landings',
    title: 'Страницы входа',
    descriptor: 'Где визиты начинаются за выбранное окно',
    about: {
      formula: 'Группировка визитов по странице ВХОДА (startURLPath). Строка — визиты и отказы страницы.',
      included: 'С выбранной целью строки дополняются достижениями и конверсией (CR) этой цели.',
      source: 'Отчёт визитов Метрики (ym:s:startURLPath).',
    },
    pageTitle: 'Все страницы входа',
    goalAria: 'Цель для страниц входа',
    errorTitle: 'Не удалось получить страницы входа',
    useData: useYmLandings,
    pageLimit: 100,
    empty: () => <EmptyState compact size="table" title="Нет визитов по страницам входа за период." />,
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.path,
        label: r.path,
        value: r.visits,
        // Отказы всегда; конверсия/достижения цели — только когда цель выбрана и метрика пришла.
        note: joinNote(
          r.bounce_rate != null
            ? `${r.bounce_rate.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}% отказов`
            : null,
          goalNote(data.goal_id, r.goal_reaches, r.goal_conversion),
        ),
      })),
      tailWord: 'визитов',
      unitTotal: data.visits_total,
    }),
  }),

  // Страницы выхода (endURLPath): зеркало входов — где визиты заканчиваются, + отказы по строке.
  defineYmBreakdown({
    key: 'ym-exits',
    title: 'Страницы выхода',
    descriptor: 'Где визиты заканчиваются за выбранное окно',
    about: {
      formula: 'Группировка визитов по странице ВЫХОДА (endURLPath) — зеркало входов. Строка — визиты и отказы.',
      source: 'Отчёт визитов Метрики (ym:s:endURLPath).',
    },
    pageTitle: 'Все страницы выхода',
    errorTitle: 'Не удалось получить страницы выхода',
    useData: useYmExits,
    pageLimit: 100,
    empty: () => <EmptyState compact size="table" title="Нет визитов по страницам выхода за период." />,
    build: (data) => ({
      rows: data.rows.map((r) => ({
        key: r.path,
        label: r.path,
        value: r.visits,
        note: breakdownNote(r.users, r.bounce_rate),
      })),
      tailWord: 'визитов',
      unitTotal: data.visits_total,
    }),
  }),
];

/** Разрез по ключу карточки/маршрута — дисптечер `/metrics/ym-*` берёт дефиницию отсюда. */
export const YM_BREAKDOWN_BY_KEY: Record<string, YmBreakdownDef | undefined> = Object.fromEntries(
  YM_BREAKDOWNS.map((def) => [def.key, def]),
);
