import { useState } from 'react';
import { useYmGoals, useYmHourly, useYmSummary } from '@/api/queries';
import { PillSelect } from '@/components/PillSelect';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { LineChart } from '@/components/LineChart';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton } from '@/components/ui/dataSkeleton';
import { InlineSpark } from '@/components/InlineSpark';
import { lttbDownsample } from '@/lib/downsample';
import { fmt } from '@/lib/format';
import { usePagePeriod } from '@/lib/period';
import { useMsPagePeriod } from '@/lib/msPeriod';
import { YM_BREAKDOWNS } from '@/panels/metrika/ymBreakdowns';

/**
 * Обзор «Яндекс.Метрики» — веб-аналитика сайта рядом с аналитикой каналов. Все числа приходят
 * СЕРВЕР-АГРЕГИРОВАННЫМИ (дневные отчёты Reporting API с accuracy=full; «Всё» хранит серии в
 * ym_daily и best-effort обогащает точными live-итогами). Величины (визиты, посетители, просмотры
 * страниц) — свои и никогда не смешиваются с TG-просмотрами или IG-охватом. Когда period totals
 * недоступны, подпись посетителей честно отмечает, что итог является суммой дневных уникальных.
 *
 * 14 разрезов (источники/гео/демография/цели/UTM/страницы) живут ОДНОЙ таблицей в
 * `ymBreakdowns.tsx` — та же дефиниция кормит и карточку доски, и полностраничный `/metrics/ym-*`.
 * Каждая карточка тянет свои данные сама и (deferData) откладывает запрос, пока не подойдёт к
 * вьюпорту: раньше все 17 запросов летели на каждый вход в /metrika и на каждую смену периода.
 */
export function YmOverview() {
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  // Окна Метрики сериализует тот же feed-топбар, что у МойСклада (msPeriod — сете-агностичный
  // хелпер): «Всё» (0) берёт серии из ym_daily, живые окна — 7/30/90/точный диапазон.
  const period = useMsPagePeriod();
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
  // Словарь целей нужен САМОЙ доске (опции синхронных селекторов), поэтому единственный разрез,
  // который остаётся на уровне страницы. Карточка «Цели» читает тот же ключ — второго запроса нет.
  const goals = useYmGoals(period);
  // Одна ЯВНО выбранная цель атрибуции на всю доску: источники/UTM/устройства/страницы входа
  // читают один и тот же выбор. Селекторы появляются, ТОЛЬКО когда на счётчике есть цели. Храним
  // id строкой (контракт PillSelect); '' = «Без цели» (дефолт — топ-цель НЕ подставляем автоматически).
  const [attributionGoal, setAttributionGoal] = useState('');
  const goalRows = goals.data?.rows ?? [];
  const hasGoals = goalRows.length > 0;
  // Период/счётчик мог смениться, пока в state остался id прежней цели. Валидируем ПРОИЗВОДНО (без
  // useEffect-починки): id обязан существовать в текущем словаре, иначе показываем «Без цели» и шлём
  // null до нового явного выбора. Одно значение — общий value всех четырёх синхронных селекторов.
  const validGoalValue = hasGoals && goalRows.some((goal) => goal.id === attributionGoal) ? attributionGoal : '';
  const selectedGoalId = validGoalValue !== '' ? Number(validGoalValue) : null;

  const summary = useYmSummary(period);
  const hourly = useYmHourly(period);
  // Общие опции + рендер синхронного селектора цели (одинаковое value/handler на всех карточках,
  // card-specific aria-label). Показываем ТОЛЬКО при наличии целей — иначе UI как прежде.
  const goalOptions = [
    { value: '', label: 'Без цели' },
    ...goalRows.map((g) => ({ value: g.id, label: g.name ?? `Цель ${g.id}` })),
  ];
  const goalSelect = (ariaLabel: string) =>
    hasGoals ? (
      <PillSelect
        value={validGoalValue}
        onValueChange={setAttributionGoal}
        ariaLabel={ariaLabel}
        // SelectTrigger is w-full by default; as a card-header action it must stay compact or it
        // pushes the title out of the flex row. Long goal names remain truncated inside the pill.
        className="h-7 w-32 shrink-0 text-2xs sm:w-40"
        options={goalOptions}
      />
    ) : undefined;

  if (summary.isPending) {
    return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-[264px] rounded-2xl border border-border bg-card p-5 lg:col-span-3">
            <ChartSkeleton />
          </div>
        ))}
      </div>
    );
  }

  if (summary.isError) {
    const status = (summary.error as { status?: number } | null)?.status;
    if (status === 401) {
      // Токен отозван на стороне Яндекса — честный reconnect-CTA вместо «недоступна».
      return (
        <EmptyState
          title="Токен Яндекса отозван"
          reason="Счётчик перестал принимать наш токен — выпустите новый OAuth-токен и переподключите."
          action={{ to: '/connect?source=metrika', label: 'Переподключить Метрику' }}
        />
      );
    }
    if (status === 404) {
      // Канал есть, а счётчика Метрики на нём нет — честный onboarding вместо пустых карточек.
      return (
        <EmptyState
          title="Яндекс.Метрика не подключена"
          reason="Укажите OAuth-токен — и здесь появятся визиты, посетители и источники трафика."
          action={{ to: '/connect?source=metrika', label: 'Подключить Метрику' }}
        />
      );
    }
    return (
      <ErrorState
        title="Не удалось получить данные Яндекс.Метрики"
        reason={summary.error instanceof Error ? summary.error.message : 'ошибка'}
        onRetry={() => summary.refetch()}
        retrying={summary.isFetching}
      />
    );
  }

  const { visits, users, pageviews } = summary.data;
  // Канон графиков: длинные серии (окно «Всё» после лет архива ym_daily) даунсэмплятся до ~140
  // точек ПЕРЕД рендером; labels/titles строятся из той же выборки, чтобы тултипы совпадали с
  // точками. Оконные 7/30/90 короче порога и проходят как есть.
  const metricCard = (
    id: string,
    title: string,
    block: { total: number; series: Array<{ day: string; value: number }> },
    caption: string,
  ) => {
    const sampled = lttbDownsample(block.series, 140, (p) => p.value);
    return (
      <ChartWidget id={id} title={title} fixedSize="half" drillTo={`/metrics/${id}`}>
        <ChartCardBody value={fmt.short(block.total)} caption={caption}>
          {sampled.length > 1 ? (
            <LineChart
              values={sampled.map((p) => p.value)}
              labels={sampled.map((p) => fmt.day(p.day))}
              titles={sampled.map((p) => `${fmt.day(p.day)}: ${fmt.num(p.value)}`)}
              yMin={0}
            />
          ) : (
            <EmptyState compact size="chart" title="Недостаточно дней для графика." />
          )}
        </ChartCardBody>
      </ChartWidget>
    );
  };

  const quality = summary.data.quality ?? null;
  const qualitySeries = summary.data.quality_series ?? null;
  const meta = summary.data.meta ?? null;
  // «Посетители» за окно теперь период-точные, когда сервер дал body.totals; при «Всё» без
  // живого токена подпись остаётся честной «сумма по дням».
  const exactTotals = meta?.exact_period_totals === true;
  const usersCaption = exactTotals ? windowLabel : `${windowLabel} · сумма по дням`;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      {metricCard('ym-visits', 'Визиты', visits, windowLabel)}
      {metricCard('ym-users', 'Посетители', users, usersCaption)}
      {metricCard('ym-pageviews', 'Просмотры страниц', pageviews, windowLabel)}

      {/* Качество трафика: отказы/длительность/глубина/новые/роботы — nullable, «—» когда недоступно. */}
      <YmQualityStrip quality={quality} qualitySeries={qualitySeries} meta={meta} windowLabel={windowLabel} />

      {/* Трафик по часам: суточный heatmap-профиль визитов (ym:s:hour) — когда приходят посетители.
          Полные 24 клетки, подпись отмечает час пика. Визиты — своя единица, не TG/IG-метрики. */}
      <YmHourlyCard hourly={hourly} windowLabel={windowLabel} />

      {/* 14 разрезов из общей таблицы: карточка = заголовок + (опц.) селектор цели + тело разреза.
          deferData откладывает запрос карточки, пока она не подойдёт к вьюпорту. */}
      {YM_BREAKDOWNS.map((def) => (
        <ChartWidget
          key={def.key}
          id={def.key}
          title={def.title}
          fixedSize="half"
          drillTo={`/metrics/${def.key}`}
          deferData
          action={def.goalAria ? goalSelect(def.goalAria) : undefined}
        >
          <def.Body period={period} goalId={selectedGoalId} surface="board" />
        </ChartWidget>
      ))}
    </div>
  );
}

/** Трафик по часам суток: доступная heatmap-сетка из 24 клеток (визиты по часу 0..23) + пик.
    Насыщенность каждой клетки нормирована на максимум текущего окна; title/aria-label сохраняют
    точные визиты и посетителей. Пустое окно — EmptyState, а не декоративная сетка нулей. */
function YmHourlyCard({
  hourly,
  windowLabel,
}: {
  hourly: ReturnType<typeof useYmHourly>;
  windowLabel: string;
}) {
  const padHour = (h: number): string => String(h).padStart(2, '0');
  const maxVisits = Math.max(0, ...(hourly.data?.rows ?? []).map((row) => row.visits));
  return (
    <ChartWidget id="ym-hourly" title="Трафик по часам" fixedSize="half" drillTo="/metrics/ym-hourly">
      {hourly.isPending ? (
        <ChartSkeleton />
      ) : hourly.isError ? (
        <ErrorState
          compact
          size="chart"
          className="py-4"
          title="Не удалось получить ритм по часам"
          reason={hourly.error instanceof Error ? hourly.error.message : 'ошибка'}
          onRetry={() => hourly.refetch()}
          retrying={hourly.isFetching}
        />
      ) : hourly.data.visits_total === 0 ? (
        <EmptyState compact size="chart" title="Нет визитов за период." />
      ) : (
        <ChartCardBody
          label="Визиты"
          value={fmt.short(hourly.data.visits_total)}
          caption={
            <span className="space-y-0.5">
              <span className="block">
                {hourly.data.peak_hour != null
                  ? `Пик в ${padHour(hourly.data.peak_hour)}:00 · ${windowLabel}`
                  : windowLabel}
              </span>
              <span className="block">Часы — в часовом поясе счётчика</span>
            </span>
          }
        >
          <div className="grid h-full grid-cols-12 content-center gap-x-1 gap-y-2">
            {hourly.data.rows.map((row) => {
              const opacity = maxVisits > 0 ? Math.max(0.1, row.visits / maxVisits) : 0.08;
              const title = `${padHour(row.hour)}:00 — ${fmt.num(row.visits)} визитов, ${fmt.num(row.users)} посетителей`;
              return (
                <div
                  key={row.hour}
                  role="img"
                  aria-label={title}
                  title={title}
                  className="min-w-0 text-center"
                >
                  <div
                    className="h-8 rounded-sm"
                    style={{ backgroundColor: 'hsl(var(--brand-iris))', opacity }}
                  />
                  <span className="mt-1 block text-2xs tabular-nums text-muted-foreground">
                    {row.hour % 3 === 0 ? row.hour : '\u00a0'}
                  </span>
                </div>
              );
            })}
          </div>
        </ChartCardBody>
      )}
    </ChartWidget>
  );
}

/** Форматтеры качества: nullable-aware, русская локаль. «—» — «нет данных», не «0». */
const fmtQualityPct = (v: number | null | undefined): string =>
  v == null ? '—' : `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
const fmtQualityNum = (v: number | null | undefined, digits = 2): string =>
  v == null ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: digits });
/** Секунды → «м:сс» (или «с» под минутой). null → «—». */
const fmtDuration = (v: number | null | undefined): string => {
  if (v == null) return '—';
  const total = Math.round(v);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s} с`;
};

interface YmQualityPoint {
  day: string;
  value: number | null;
}
interface YmQualitySeries {
  bounce_rate?: YmQualityPoint[];
  avg_visit_duration_seconds?: YmQualityPoint[];
  page_depth?: YmQualityPoint[];
  new_users?: YmQualityPoint[];
  percent_new_visitors?: YmQualityPoint[];
  robot_visits?: YmQualityPoint[];
  robot_percentage?: YmQualityPoint[];
}
type YmQualitySeriesKey = keyof YmQualitySeries;
interface YmQualityTile {
  key: string;
  label: string;
  value: string;
  /** Ключ дневной серии качества для тренд-спарклайна (тренд — по РЕАЛЬНЫМ точкам, null пропущены). */
  seriesKey: YmQualitySeriesKey;
}

/** Доля роботов + их число: «12,3% · 45». Оба null → «—»; показываем, а не исключаем молча. */
const fmtRobots = (pct: number | null | undefined, count: number | null | undefined): string => {
  if (pct == null && count == null) return '—';
  return [pct != null ? fmtQualityPct(pct) : null, count != null ? fmt.short(count) : null]
    .filter(Boolean)
    .join(' · ');
};

/** Полоса качества трафика: 6 KPI (включая явную роботность) с компактными тренд-спарклайнами +
    тихая сноска о свежести/сэмплировании (без шумных бейджей). Спарклайн показывается, только
    когда у метрики есть ≥2 реальных дневных точки; спарклайн декоративен (aria-hidden) — значение
    уже дано числом, поэтому доступность и пустые/загрузочные состояния не меняются. */
function YmQualityStrip({
  quality,
  qualitySeries,
  meta,
  windowLabel,
}: {
  quality: {
    bounce_rate: number | null;
    avg_visit_duration_seconds: number | null;
    page_depth: number | null;
    new_users: number | null;
    percent_new_visitors: number | null;
    robot_visits?: number | null;
    robot_percentage?: number | null;
  } | null;
  qualitySeries: YmQualitySeries | null;
  meta: {
    exact_period_totals: boolean;
    all_time?: boolean;
    archive_last_day?: string | null;
    sampled?: boolean;
    sample_share?: number;
    data_lag?: number;
  } | null;
  windowLabel: string;
}) {
  const tiles: YmQualityTile[] = [
    { key: 'bounce', label: 'Отказы', value: fmtQualityPct(quality?.bounce_rate), seriesKey: 'bounce_rate' },
    { key: 'dur', label: 'Средний визит', value: fmtDuration(quality?.avg_visit_duration_seconds), seriesKey: 'avg_visit_duration_seconds' },
    { key: 'depth', label: 'Глубина', value: fmtQualityNum(quality?.page_depth), seriesKey: 'page_depth' },
    { key: 'new', label: 'Новые', value: fmt.short(quality?.new_users ?? null), seriesKey: 'new_users' },
    { key: 'pctnew', label: 'Доля новых', value: fmtQualityPct(quality?.percent_new_visitors), seriesKey: 'percent_new_visitors' },
    { key: 'robots', label: 'Роботы', value: fmtRobots(quality?.robot_percentage, quality?.robot_visits), seriesKey: 'robot_percentage' },
  ];
  // Тренд-спарклайн: только РЕАЛЬНЫЕ дневные точки метрики (null = «нет данных» пропускаем), и
  // только когда их ≥2 — иначе InlineSpark сам ничего не рисует, но экономим и пустой контейнер.
  const trendValues = (key: YmQualitySeriesKey): number[] => {
    const points = qualitySeries?.[key];
    if (!Array.isArray(points)) return [];
    const realPoints = points.filter((p): p is { day: string; value: number } => p.value != null);
    // An all-time archive can span thousands of days. The 72px sparkline cannot represent that
    // many vertices usefully, so retain its shape with the same LTTB helper as the main charts.
    const values = lttbDownsample(realPoints, 48, (p) => p.value).map((p) => p.value);
    return values.length >= 2 ? values : [];
  };
  // Свежесть/качество данных — одна приглушённая строка, элементы включаются только по факту.
  const notes: string[] = [];
  if (meta && meta.exact_period_totals === false) {
    notes.push('точные итоги за период недоступны');
  }
  if (meta?.sampled) {
    notes.push(
      meta.sample_share != null
        ? `выборка ${Math.round(meta.sample_share * 100)}%`
        : 'данные семплированы',
    );
  }
  if (meta?.data_lag != null && meta.data_lag > 0) {
    const hours = Math.round(meta.data_lag / 3600);
    notes.push(hours >= 1 ? `задержка данных ~${hours} ч` : 'данные обрабатываются');
  }
  if (meta?.all_time && meta.archive_last_day) {
    notes.push(`архив по ${fmt.day(meta.archive_last_day)}`);
  }
  return (
    <div data-testid="ym-quality-strip" className="rounded-2xl border border-border bg-card p-5 lg:col-span-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">Качество трафика</h3>
        <span className="text-2xs text-muted-foreground">{windowLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => {
          const trend = trendValues(t.seriesKey);
          return (
            <div key={t.key} className="min-w-0">
              <div className="text-2xs tracking-wide text-muted-foreground">{t.label}</div>
              <div className="mt-0.5 text-lg font-medium tabular-nums tracking-tight text-foreground">{t.value}</div>
              {trend.length >= 2 && (
                <div className="mt-1 h-4">
                  <InlineSpark values={trend} width={72} height={16} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* Роботность показана в трафике, а не исключена автоматически — честная оговорка. */}
      <p className="mt-3 text-2xs text-muted-foreground">
        Роботы «по поведению» учтены в визитах и качестве, а не исключены автоматически.
      </p>
      {notes.length > 0 && <p className="mt-1 text-2xs text-muted-foreground">{notes.join(' · ')}</p>}
    </div>
  );
}
