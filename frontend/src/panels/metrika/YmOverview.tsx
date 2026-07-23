import { useContext, useState } from 'react';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import {
  useYmCities,
  useYmCountries,
  useYmDevices,
  useYmExits,
  useYmGoals,
  useYmHourly,
  useYmLandings,
  useYmMessengers,
  useYmPages,
  useYmReferrers,
  useYmSocial,
  useYmSources,
  useYmSummary,
  useYmUtm,
} from '@/api/queries';
import { PillSelect } from '@/components/PillSelect';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { LineChart } from '@/components/LineChart';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton, TableSkeleton } from '@/components/ui/dataSkeleton';
import { InlineSpark } from '@/components/InlineSpark';
import { lttbDownsample } from '@/lib/downsample';
import { fmt } from '@/lib/format';
import { usePagePeriod } from '@/lib/period';
import { useMsPagePeriod } from '@/lib/msPeriod';

/**
 * Обзор «Яндекс.Метрики» — веб-аналитика сайта рядом с аналитикой каналов. Все числа приходят
 * СЕРВЕР-АГРЕГИРОВАННЫМИ (дневные отчёты Reporting API с accuracy=full; «Всё» хранит серии в
 * ym_daily и best-effort обогащает точными live-итогами). Величины (визиты, посетители, просмотры
 * страниц) — свои и никогда не смешиваются с TG-просмотрами или IG-охватом. Когда period totals
 * недоступны, подпись посетителей честно отмечает, что итог является суммой дневных уникальных.
 */
/** Локализация типов устройств по стабильному значению ym:s:deviceCategory. Reporting API может
    вернуть числовой id, а документация группировки называет строковые значения — поддерживаем оба. */
const YM_DEVICE_LABELS: Record<string, string> = {
  '1': 'Десктоп',
  '2': 'Смартфоны',
  '3': 'Планшеты',
  '4': 'ТВ',
  desktop: 'Десктоп',
  mobile: 'Смартфоны',
  tablet: 'Планшеты',
  tv: 'ТВ',
};

/** Вторичный контекст строки разреза: посетители + отказы (когда доступны). Отказы nullable —
    «—»-семантика: при null подпункт отказов просто опускается, а не превращается в «0%». */
const breakdownNote = (users: number, bounceRate: number | null): string =>
  [
    `${fmt.num(users)} чел.`,
    bounceRate != null ? `${bounceRate.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}% отказов` : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** Контекст выбранной цели для строки разреза: конверсия (CR, %) + число достижений. Возвращает
    null, когда цель не выбрана (goalId==null) — тогда строка остаётся с базовым (визиты/отказы)
    контекстом. Конверсия/достижения nullable по отдельности: показываем то, что реально пришло. */
const goalNote = (
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
const joinNote = (base: string | null, goal: string | null): string | null =>
  [base, goal].filter(Boolean).join(' · ') || null;

export function YmOverview() {
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  // Окна Метрики сериализует тот же feed-топбар, что у МойСклада (msPeriod — сете-агностичный
  // хелпер): «Всё» (0) берёт серии из ym_daily, живые окна — 7/30/90/точный диапазон.
  const period = useMsPagePeriod();
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
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
  const sources = useYmSources(period, selectedGoalId);
  const referrers = useYmReferrers(period);
  const social = useYmSocial(period);
  const messengers = useYmMessengers(period);
  const countries = useYmCountries(period);
  const cities = useYmCities(period);
  const devices = useYmDevices(period, selectedGoalId);
  const utm = useYmUtm(period, selectedGoalId);
  const pages = useYmPages(period);
  const landings = useYmLandings(period, selectedGoalId);
  const hourly = useYmHourly(period);
  const exits = useYmExits(period);
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
      <ChartWidget id={id} title={title} fixedSize="half">
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

      <ChartWidget
        id="ym-sources"
        title="Источники трафика"
        fixedSize="half"
        action={goalSelect('Цель для источников трафика')}
      >
        {sources.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : sources.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить источники трафика"
            reason={sources.error instanceof Error ? sources.error.message : 'ошибка'}
            onRetry={() => sources.refetch()}
            retrying={sources.isFetching}
          />
        ) : sources.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет визитов за период." />
        ) : (
          <YmBreakdownRows
            rows={sources.data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? 'Другие источники',
              value: r.visits,
              note: joinNote(
                `${fmt.num(r.users)} чел.`,
                goalNote(sources.data.goal_id, r.goal_reaches, r.goal_conversion),
              ),
            }))}
            tailWord="визитов"
            unitTotal={sources.data.visits_total}
          />
        )}
      </ChartWidget>

      {/* Реферальные сайты: внешние домены (externalRefererDomain) — визиты + отказы по строке. */}
      <ChartWidget id="ym-referrers" title="Реферальные сайты" fixedSize="half">
        {referrers.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : referrers.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить реферальные сайты"
            reason={referrers.error instanceof Error ? referrers.error.message : 'ошибка'}
            onRetry={() => referrers.refetch()}
            retrying={referrers.isFetching}
          />
        ) : referrers.data.rows.length === 0 ? (
          <EmptyState
            compact
            size="table"
            title="Реферальных переходов за период нет."
            reason="Здесь появятся внешние сайты, приводящие трафик по ссылкам."
          />
        ) : (
          <YmBreakdownRows
            rows={referrers.data.rows.map((r) => ({
              key: r.name ?? r.id ?? 'unknown',
              label: r.name ?? r.id ?? 'домен',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            }))}
            tailWord="визитов"
            unitTotal={referrers.data.visits_total}
          />
        )}
      </ChartWidget>

      {/* Соцсети: конкретные сети (lastsignSocialNetwork) — визиты + отказы по строке. */}
      <ChartWidget id="ym-social" title="Соцсети" fixedSize="half">
        {social.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : social.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить соцсети"
            reason={social.error instanceof Error ? social.error.message : 'ошибка'}
            onRetry={() => social.refetch()}
            retrying={social.isFetching}
          />
        ) : social.data.rows.length === 0 ? (
          <EmptyState
            compact
            size="table"
            title="Переходов из соцсетей за период нет."
            reason="Здесь появятся конкретные соцсети, приводящие трафик."
          />
        ) : (
          <YmBreakdownRows
            rows={social.data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? r.id ?? 'соцсеть',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            }))}
            tailWord="визитов"
            unitTotal={social.data.visits_total}
          />
        )}
      </ChartWidget>

      {/* Мессенджеры: отдельная размерность Метрики — Telegram не теряется внутри «Соцсетей». */}
      <ChartWidget id="ym-messengers" title="Мессенджеры" fixedSize="half">
        {messengers.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : messengers.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить мессенджеры"
            reason={messengers.error instanceof Error ? messengers.error.message : 'ошибка'}
            onRetry={() => messengers.refetch()}
            retrying={messengers.isFetching}
          />
        ) : messengers.data.rows.length === 0 ? (
          <EmptyState
            compact
            size="table"
            title="Переходов из мессенджеров за период нет."
            reason="Здесь появятся Telegram и другие мессенджеры, приводящие трафик."
          />
        ) : (
          <YmBreakdownRows
            rows={messengers.data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? r.id ?? 'мессенджер',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            }))}
            tailWord="визитов"
            unitTotal={messengers.data.visits_total}
          />
        )}
      </ChartWidget>

      {/* Устройства: тип устройства (deviceCategory) — локализация по стабильному id, имя — фолбэк. */}
      <ChartWidget
        id="ym-devices"
        title="Устройства"
        fixedSize="half"
        action={goalSelect('Цель для устройств')}
      >
        {devices.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : devices.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить устройства"
            reason={devices.error instanceof Error ? devices.error.message : 'ошибка'}
            onRetry={() => devices.refetch()}
            retrying={devices.isFetching}
          />
        ) : devices.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет визитов за период." />
        ) : (
          <YmBreakdownRows
            rows={devices.data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: (r.id != null ? YM_DEVICE_LABELS[r.id] : undefined) ?? r.name ?? 'Другие устройства',
              value: r.visits,
              note: joinNote(
                breakdownNote(r.users, r.bounce_rate),
                goalNote(devices.data.goal_id, r.goal_reaches, r.goal_conversion),
              ),
            }))}
            tailWord="визитов"
            unitTotal={devices.data.visits_total}
          />
        )}
      </ChartWidget>

      {/* Страны: география посетителей (regionCountry) — визиты + отказы по строке, имя lang=ru. */}
      <ChartWidget id="ym-countries" title="Страны" fixedSize="half">
        {countries.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : countries.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить страны"
            reason={countries.error instanceof Error ? countries.error.message : 'ошибка'}
            onRetry={() => countries.refetch()}
            retrying={countries.isFetching}
          />
        ) : countries.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет визитов за период." />
        ) : (
          <YmBreakdownRows
            rows={countries.data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? r.id ?? 'страна',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            }))}
            tailWord="визитов"
            unitTotal={countries.data.visits_total}
            footnote="География определяется Метрикой по данным визита, а не по GPS."
          />
        )}
      </ChartWidget>

      {/* Города: география посетителей (regionCity) — отдельная от страны размерность. */}
      <ChartWidget id="ym-cities" title="Города" fixedSize="half">
        {cities.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : cities.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить города"
            reason={cities.error instanceof Error ? cities.error.message : 'ошибка'}
            onRetry={() => cities.refetch()}
            retrying={cities.isFetching}
          />
        ) : cities.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет визитов за период." />
        ) : (
          <YmBreakdownRows
            rows={cities.data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? r.id ?? 'город',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            }))}
            tailWord="визитов"
            unitTotal={cities.data.visits_total}
          />
        )}
      </ChartWidget>

      {/* Цели: reaches за окно + конверсия отдельной метрикой (CR не выводится из reaches). */}
      <ChartWidget id="ym-goals" title="Цели" fixedSize="half">
        {goals.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : goals.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить цели"
            reason={goals.error instanceof Error ? goals.error.message : 'ошибка'}
            onRetry={() => goals.refetch()}
            retrying={goals.isFetching}
          />
        ) : goals.data.rows.length === 0 ? (
          <EmptyState
            compact
            size="table"
            title="На счётчике нет целей."
            reason="Настройте цели в Яндекс.Метрике — конверсии появятся здесь."
          />
        ) : (
          <YmBreakdownRows
            rows={goals.data.rows.map((g) => ({
              key: g.id,
              label: g.name ?? `Цель ${g.id}`,
              value: g.reaches,
              // Конверсия — не знаковая дельта (fmt.pct) и не целое (fmt.num): доли процента
              // значимы, локаль ru даёт запятую.
              note: `CR ${g.conversion_rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%`,
            }))}
            tailWord="достижений"
            footnote={goals.data.truncated ? 'Показаны первые 20 целей счётчика.' : null}
          />
        )}
      </ChartWidget>

      {/* UTM: только размеченные визиты в строках; неразмеченные — честной сноской, не строкой. */}
      <ChartWidget
        id="ym-utm"
        title="UTM-метки"
        fixedSize="half"
        action={goalSelect('Цель для UTM-меток')}
      >
        {utm.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : utm.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить UTM-разметку"
            reason={utm.error instanceof Error ? utm.error.message : 'ошибка'}
            onRetry={() => utm.refetch()}
            retrying={utm.isFetching}
          />
        ) : utm.data.rows.length === 0 ? (
          <EmptyState
            compact
            size="table"
            title="UTM-меток за период нет."
            reason="Размечайте ссылки в постах utm_source — источники появятся здесь."
          />
        ) : (
          <YmBreakdownRows
            rows={utm.data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? r.id ?? 'utm',
              value: r.visits,
              note: joinNote(`${fmt.num(r.users)} чел.`, goalNote(utm.data.goal_id, r.goal_reaches, r.goal_conversion)),
            }))}
            tailWord="визитов"
            unitTotal={utm.data.tagged_visits}
            footnote={
              utm.data.untagged_visits > 0
                ? `Без метки — ${fmt.num(utm.data.untagged_visits)} визитов из ${fmt.num(utm.data.visits_total)}.`
                : null
            }
          />
        )}
      </ChartWidget>

      {/* Топ-страницы: hits-отчёт (просмотры страниц ≠ визиты — другая единица, чем сверху). */}
      <ChartWidget id="ym-pages" title="Топ-страницы" fixedSize="half">
        {pages.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : pages.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить страницы"
            reason={pages.error instanceof Error ? pages.error.message : 'ошибка'}
            onRetry={() => pages.refetch()}
            retrying={pages.isFetching}
          />
        ) : pages.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет просмотров за период." />
        ) : (
          <YmBreakdownRows
            rows={pages.data.rows.map((r) => ({
              key: r.path,
              label: r.path,
              value: r.pageviews,
              note: `${fmt.num(r.users)} чел.`,
            }))}
            tailWord="просмотров"
            unitTotal={pages.data.pageviews_total}
          />
        )}
      </ChartWidget>

      {/* Страницы входа (startURLPath): визиты + отказы, опц. конверсия выбранной цели. */}
      <ChartWidget
        id="ym-landings"
        title="Страницы входа"
        fixedSize="half"
        action={goalSelect('Цель для страниц входа')}
      >
        {landings.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : landings.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить страницы входа"
            reason={landings.error instanceof Error ? landings.error.message : 'ошибка'}
            onRetry={() => landings.refetch()}
            retrying={landings.isFetching}
          />
        ) : landings.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет визитов по страницам входа за период." />
        ) : (
          <YmBreakdownRows
            rows={landings.data.rows.map((r) => ({
              key: r.path,
              label: r.path,
              value: r.visits,
              // Отказы всегда; конверсия/достижения цели — только когда цель выбрана и метрика пришла.
              note: joinNote(
                r.bounce_rate != null
                  ? `${r.bounce_rate.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}% отказов`
                  : null,
                goalNote(landings.data.goal_id, r.goal_reaches, r.goal_conversion),
              ),
            }))}
            tailWord="визитов"
            unitTotal={landings.data.visits_total}
          />
        )}
      </ChartWidget>

      {/* Страницы выхода (endURLPath): зеркало входов — где визиты заканчиваются, + отказы по строке. */}
      <ChartWidget id="ym-exits" title="Страницы выхода" fixedSize="half">
        {exits.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : exits.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить страницы выхода"
            reason={exits.error instanceof Error ? exits.error.message : 'ошибка'}
            onRetry={() => exits.refetch()}
            retrying={exits.isFetching}
          />
        ) : exits.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет визитов по страницам выхода за период." />
        ) : (
          <YmBreakdownRows
            rows={exits.data.rows.map((r) => ({
              key: r.path,
              label: r.path,
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            }))}
            tailWord="визитов"
            unitTotal={exits.data.visits_total}
          />
        )}
      </ChartWidget>
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
    <ChartWidget id="ym-hourly" title="Трафик по часам" fixedSize="half">
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

/** Общие строки breakdown-карточек Метрики (источники/цели/UTM/страницы): компактный топ-4 по
    value + сводный хвост «Ещё N <word> [из M]»; разворот карточки показывает ВСЕ строки отчёта.
    Бары — тихий одноцветный канон (цвет серии, не оценка), как статусы заказов у МС. */
export function YmBreakdownRows({
  rows,
  tailWord,
  unitTotal = null,
  footnote = null,
}: {
  rows: Array<{ key: string; label: string; value: number; note: string | null }>;
  /** Слово хвоста в родительном падеже множественного («визитов», «достижений», «просмотров»). */
  tailWord: string;
  /** Итог ПОЛНОГО отчёта для «Ещё N … из M.»; null — хвост без «из M». */
  unitTotal?: number | null;
  /** Приглушённая сноска под списком (усечение целей, визиты без метки). */
  footnote?: string | null;
}) {
  const expanded = useContext(ChartExpandedContext);
  // Сервер уже сортирует по убыванию; пересортировка здесь — страховка стабильности вида.
  const ranked = [...rows].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const top = expanded ? ranked : ranked.slice(0, 4);
  const tail = expanded ? [] : ranked.slice(4);
  const restValue = tail.reduce((acc, row) => acc + row.value, 0);
  const max = Math.max(1, ...top.map((row) => Math.max(0, row.value)));
  return (
    <div className={expanded ? 'space-y-2 pt-1' : 'space-y-1.5'}>
      {top.map((r) => (
        <div key={r.key}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-foreground">{r.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{fmt.num(r.value)}</span>
              {r.note != null && <>{' · '}{r.note}</>}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(4, Math.round((Math.max(0, r.value) / max) * 100))}%`,
                backgroundColor: 'hsl(var(--chart-role-primary) / 0.75)',
              }}
            />
          </div>
        </div>
      ))}
      {restValue > 0 && (
        <p className="text-2xs text-muted-foreground">
          Ещё {fmt.num(restValue)} {tailWord}{unitTotal != null ? ` из ${fmt.num(unitTotal)}` : ''}.
        </p>
      )}
      {footnote != null && <p className="text-2xs text-muted-foreground">{footnote}</p>}
    </div>
  );
}
