import { useMemo } from 'react';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { BarChart } from '@/components/BarChart';
import { ChartBand } from '@/components/ChartBand';
import { Sparkline } from '@/components/Sparkline';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton } from '@/components/ui/dataSkeleton';
import { useRusenderStatus, useRusenderSummary, type RusenderPoint } from '@/api/rusender';
import { useGatedSurfaces } from '@/components/layout/nav';
import { useSelectedChannel } from '@/lib/channel-context';
import { lttbDownsample } from '@/lib/downsample';
import { CHART_MAX_POINTS } from '@/lib/msSeries';
import { fmt, timeAxisFromDayKeys } from '@/lib/format';
import { formatByRole } from '@/lib/metricNumber';
import { usePagePeriod, useCardShowsPeriod } from '@/lib/period';

/**
 * «Обзор» Rusender — email-рассылки рядом с аналитикой каналов.
 *
 * ГЛАВНОЕ УСТРОЙСТВО СТРАНИЦЫ — две НЕСМЕШИВАЕМЫЕ группы величин:
 *
 *   • «События периода» — открытия и клики, которые СЛУЧИЛИСЬ в окне. Сюда попадают открытия
 *     писем, отправленных до окна: письмо живёт неделями. Это единственный настоящий временной
 *     ряд источника, и только он рисуется графиком.
 *   • «Рассылки периода» — итоги кампаний, ЗАПУЩЕННЫХ в окне: отправлено, доставлено, отписки.
 *     Это кумулятивные счётчики кампаний, а не события дня, поэтому графиком они не рисуются —
 *     разложить их по дням честно нельзя.
 *
 * Эти числа НЕ обязаны совпадать и никогда не складываются — тот же канон, что «Просмотры
 * канала» ≠ «Просмотры публикаций» у Telegram. Подписи карточек проговаривают разницу словами,
 * а не оставляют её на догадку.
 *
 * База контактов — снимок, а не поток: истории размера базы у Rusender API нет, мы копим её сами
 * с момента подключения. Поэтому у линии базы честный разрыв в днях без снимка (NULL), а не ноль.
 */

/**
 * Тело story-карточки: крупное число + дневной ряд.
 *
 * Пропуски (null) НЕ приводятся к нулю: у базы контактов день без снимка — это дыра в сборе, а
 * не обнулившаяся база. BarChart рисует такой день штриховкой, Sparkline разрывает линию.
 */
function RusenderStory({
  value,
  caption,
  series,
  viz,
}: {
  value: string;
  caption?: string;
  series: Array<{ day: string; value: number | null }>;
  viz: 'line' | 'bar';
}) {
  const model = useMemo(() => {
    // Даунсэмпл ПАРАМИ (день + значение): дели их порознь, подписи оси разъехались бы с рядом.
    const shown = lttbDownsample(series, CHART_MAX_POINTS, (r) => r.value ?? 0);
    return { values: shown.map((r) => r.value), days: shown.map((r) => r.day) };
  }, [series]);

  if (model.values.length <= 1) {
    return (
      <ChartCardBody value={value} caption={caption}>
        <EmptyState compact size="chart" title="Недостаточно дней для графика." />
      </ChartCardBody>
    );
  }
  const labels = model.days.map((d) => fmt.day(d));
  const axisLabels = timeAxisFromDayKeys(model.days);
  const titles = model.values.map((v, i) => `${labels[i] ?? ''}: ${v == null ? 'данных нет' : fmt.num(v)}`);

  return (
    <ChartCardBody value={value} caption={caption}>
      {viz === 'bar' ? (
        // ChartBand без флекс-КОЛОНКИ-родителя не ограничен ничем и переполняет фикс-тайл
        // (урок карточек СДЭКа) — колонка во всю высоту слота даёт полосе честный остаток.
        <div className="flex h-full min-h-0 flex-col">
          <ChartBand>
            <BarChart values={model.values} labels={labels} axisLabels={axisLabels} titles={titles} />
          </ChartBand>
        </div>
      ) : (
        <Sparkline
          values={model.values}
          labels={labels}
          axisLabels={axisLabels}
          area
          strokeWidth={2}
          interactive
          caption=""
          formatValue={fmt.num}
        />
      )}
    </ChartCardBody>
  );
}

export function RusenderOverview() {
  const { channelId } = useSelectedChannel();
  const { rusenderSurfaces } = useGatedSurfaces();
  const status = useRusenderStatus(channelId);
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  const summary = useRusenderSummary(channelId, days, rusenderSurfaces);

  const connected = status.data?.connected ?? false;
  const missing = status.data?.missing_scopes ?? [];
  const windowLabel = days === 0 ? 'за всё время' : `за ${days} дн.`;
  const periodInLabel = useCardShowsPeriod() ? windowLabel : undefined;

  // Разрешения могли отозвать уже ПОСЛЕ подключения — источник жив, но собирать ему нечем.
  // Это отдельная беда от «не подключён», и она заслуживает отдельного текста.
  if (connected && missing.length) {
    return (
      <EmptyState
        title="Ключу не хватает разрешений"
        reason={`Rusender не отдаёт данные: у ключа нет ${missing.join(', ')}. Выдай их ключу в кабинете Rusender и подключи источник заново.`}
        action={{ to: '/connect', label: 'К подключению' }}
      />
    );
  }

  if (status.isSuccess && !connected) {
    return (
      <EmptyState
        title="Rusender не подключён"
        reason="Подключи аккаунт по API-ключу — после этого сюда приедут рассылки, открытия и размер базы."
        action={{ to: '/connect', label: 'Подключить Rusender' }}
      />
    );
  }

  // Витрины за фичефлагом: пока он выключен, роутов данных для клиента НЕ существует. Показываем
  // честное состояние сбора вместо пустых осей, которые читались бы как «рассылок нет».
  if (!rusenderSurfaces) {
    return (
      <EmptyState
        title="Источник подключён, собираем данные"
        reason={
          <>
            {status.data?.account_email ? `Аккаунт ${status.data.account_email}. ` : ''}
            Архив рассылок и дневная активность уже копятся. Витрины включатся, когда числа
            сверены с живыми данными Rusender.
          </>
        }
      />
    );
  }

  if (summary.isError) return <ErrorState onRetry={() => void summary.refetch()} />;

  const data = summary.data;
  const ev = data?.events;
  const cm = data?.campaigns;
  const contacts = data?.contacts;
  const series: RusenderPoint[] = data?.series ?? [];

  // Пустой архив: сбор ещё не проходил (джоб ходит раз в сутки). Это не «нет рассылок».
  if (summary.isSuccess && !series.length && !(cm?.campaigns ?? 0)) {
    return (
      <EmptyState
        title="Сбор ещё не проходил"
        reason="Первый дневной проход заберёт рассылки и размер базы. Дневная активность копится с момента подключения — истории у Rusender API нет."
      />
    );
  }

  const openRate = cm && cm.delivered > 0 ? (cm.opens / cm.delivered) * 100 : null;
  const clickRate = cm && cm.delivered > 0 ? (cm.clicks / cm.delivered) * 100 : null;
  const pending = summary.isPending;

  return (
    <>
      {/* СОБЫТИЯ ПЕРИОДА — единственный настоящий временной ряд, поэтому только он с графиком.
          Столбцы, а не линия: открытия и клики — дискретные счётные события дня (канон bar). */}
      <ChartWidget id="rusender-opens" title="Открытия" fixedSize="half" defaultColor={1} defaultTinted>
        {pending ? (
          <ChartSkeleton />
        ) : (
          <RusenderStory
            value={formatByRole(ev?.opens ?? 0, 'headline')}
            caption={`Открытия ${periodInLabel ?? ''} — события окна: входят открытия писем, отправленных раньше. Rusender ведёт дневной ряд 11 дней от отправки, поэтому более поздние открытия видны только в итогах рассылки.`.trim()}
            series={series.map((p) => ({ day: p.day, value: p.opens }))}
            viz="bar"
          />
        )}
      </ChartWidget>

      <ChartWidget id="rusender-clicks" title="Клики" fixedSize="half">
        {pending ? (
          <ChartSkeleton />
        ) : (
          <RusenderStory
            value={formatByRole(ev?.clicks ?? 0, 'headline')}
            caption={`Клики ${periodInLabel ?? ''} — события окна, как и открытия.`.trim()}
            series={series.map((p) => ({ day: p.day, value: p.clicks }))}
            viz="bar"
          />
        )}
      </ChartWidget>

      {/* БАЗА КОНТАКТОВ — снимок, а не поток: линия, и с честным разрывом в днях без снимка. */}
      <ChartWidget id="rusender-base" title="База контактов" fixedSize="half" noStretch>
        {pending ? (
          <ChartSkeleton />
        ) : (
          <RusenderStory
            value={contacts?.contacts_total != null ? formatByRole(contacts.contacts_total, 'headline') : '—'}
            caption={
              contacts?.day
                ? `Контактов в базе. Снимок на ${fmt.date(contacts.day)}; история копится с момента подключения — у Rusender её нет.`
                : 'Снимок базы ещё не снят.'
            }
            series={series.map((p) => ({ day: p.day, value: p.contacts_total }))}
            viz="line"
          />
        )}
      </ChartWidget>

      {/* РАССЫЛКИ ПЕРИОДА — кумулятивные итоги кампаний, запущенных в окне. Графика СОЗНАТЕЛЬНО
          нет: разложить итог рассылки по дням честно нельзя, а нарисованная «линия доставок»
          выглядела бы как поток, которым не является. */}
      <ChartWidget id="rusender-campaigns-window" title="Рассылки периода" fixedSize="half" noStretch>
        {pending ? (
          <ChartSkeleton />
        ) : (
          <ChartCardBody
            value={formatByRole(cm?.campaigns ?? 0, 'headline')}
            caption={`Запущено ${periodInLabel ?? ''} — итоги кумулятивные, по дням не раскладываются, поэтому без графика.`.trim()}
          >
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Row label="Отправлено" value={fmt.kpi(cm?.total ?? 0)} />
              <Row label="Доставлено" value={fmt.kpi(cm?.delivered ?? 0)} />
              <Row label="Открытий" value={fmt.kpi(cm?.opens ?? 0)} sub={openRate != null ? `${openRate.toFixed(1)}%` : undefined} />
              <Row label="Кликов" value={fmt.kpi(cm?.clicks ?? 0)} sub={clickRate != null ? `${clickRate.toFixed(1)}%` : undefined} />
              <Row label="Отписок" value={fmt.kpi(cm?.unsubscribes ?? 0)} />
              <Row label="Жалоб" value={fmt.kpi(cm?.complaints ?? 0)} />
            </dl>
          </ChartCardBody>
        )}
      </ChartWidget>
    </>
  );
}

/** Строка сводки: величина + необязательная доля от доставленных. */
function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="shrink-0 tabular-nums text-foreground">
        {value}
        {sub && <span className="ml-1 text-xs text-muted-foreground">{sub}</span>}
      </dd>
    </div>
  );
}
