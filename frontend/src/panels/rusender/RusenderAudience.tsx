import { useMemo } from 'react';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { ChartBand } from '@/components/ChartBand';
import { BarChart } from '@/components/BarChart';
import { Sparkline } from '@/components/Sparkline';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton } from '@/components/ui/dataSkeleton';
import { useRusenderSummary } from '@/api/rusender';
import { useGatedSurfaces } from '@/components/layout/nav';
import { useSelectedChannel } from '@/lib/channel-context';
import { lttbDownsample } from '@/lib/downsample';
import { CHART_MAX_POINTS } from '@/lib/msSeries';
import { fmt, timeAxisFromDayKeys } from '@/lib/format';
import { formatByRole } from '@/lib/metricNumber';
import { useMsPagePeriod } from '@/lib/msPeriod';
import { WidgetGrid } from '@/components/widgets/WidgetGrid';

/**
 * «База» — аудитория источника: размер базы контактов и её убыль.
 *
 * ГЛАВНАЯ ЧЕСТНОСТЬ ЭТОГО ЭКРАНА: истории размера базы у Rusender API НЕТ —
 * /contacts/statistics отдаёт только «сейчас». Всё, что здесь нарисовано, мы накопили сами
 * с момента подключения источника, и дорисовать прошлое нечем. Поэтому:
 *   • линия базы начинается с даты подключения, а не с рождения аккаунта;
 *   • день без снимка — РАЗРЫВ линии (null), а не ноль: это дыра в сборе, а не обнулившаяся база.
 * Подписи карточек это проговаривают, чтобы короткая история не читалась как «база молодая».
 */
export function RusenderAudience() {
  const { channelId } = useSelectedChannel();
  const { rusenderSurfaces } = useGatedSurfaces();
  const period = useMsPagePeriod();
  const summary = useRusenderSummary(channelId, period, rusenderSurfaces);

  const series = summary.data?.series ?? [];
  const model = useMemo(() => {
    const raw = series.map((p) => ({ day: p.day, total: p.contacts_total, unsub: p.contacts_unsubscribed }));
    const shown = lttbDownsample(raw, CHART_MAX_POINTS, (r) => r.total ?? 0);
    return {
      days: shown.map((r) => r.day),
      total: shown.map((r) => r.total),
      unsub: shown.map((r) => r.unsub),
    };
  }, [series]);

  if (!rusenderSurfaces) {
    return (
      <EmptyState
        title="Раздел ещё не включён"
        reason="База появится, когда числа Rusender сверены с живыми данными. Архив тем временем копится."
        action={{ to: '/rusender', label: 'К обзору' }}
      />
    );
  }

  if (summary.isError) return <ErrorState onRetry={() => void summary.refetch()} />;

  const contacts = summary.data?.contacts;
  // Снимков может не быть вовсе: джоб ходит раз в сутки, а история короче суток — это норма
  // первого дня, а не поломка.
  const hasSnapshot = contacts?.contacts_total != null;
  if (summary.isSuccess && !hasSnapshot) {
    return (
      <EmptyState
        title="Снимок базы ещё не снят"
        reason="Размер базы записывается дневным проходом. Истории у Rusender API нет — она копится с момента подключения, поэтому первый снимок появится в ближайшие сутки."
      />
    );
  }

  const labels = model.days.map((d) => fmt.day(d));
  const axisLabels = timeAxisFromDayKeys(model.days);
  // Считаем ДНИ СО СНИМКОМ, а не дни окна. Окно всегда плотное (90 точек), но снимок базы
  // делается дневным проходом и существует только с момента подключения: на проде «Размер базы»
  // рисовал ПУСТОЙ график — Sparkline получал 89 пропусков и одно значение, и линии не было,
  // хотя условие «дней хватает» формально выполнялось.
  const snapshotDays = model.total.filter((v) => v != null).length;
  const enoughDays = snapshotDays > 1;
  const pending = summary.isPending;

  return (
    // Сетка доски — та же, что у остальных Обзоров. Без неё `fixedSize="half"` не работает:
    // у блочного родителя нет колонок, и карточки идут одной колонкой во всю ширину.
    <WidgetGrid className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      {/* Размер базы — УРОВЕНЬ, а не поток: линия. Столбцы намекали бы, что дни складываются. */}
      <ChartWidget
        id="rusender-base-total"
        title="Размер базы"
        fixedSize="half"
        defaultColor={1}
        defaultTinted
        drillTo="/metrics/rusender-contacts"
      >
        {pending ? (
          <ChartSkeleton />
        ) : (
          <ChartCardBody
            value={formatByRole(contacts?.contacts_total ?? 0, 'headline')}
            caption={contacts?.day ? `Снимок на ${fmt.date(contacts.day)}` : 'Снимок ещё не снят'}
          >
            {enoughDays ? (
              <Sparkline
                values={model.total}
                labels={labels}
                axisLabels={axisLabels}
                area
                strokeWidth={2}
                interactive
                caption=""
                formatValue={fmt.num}
                // Тот же класс, что у искр МойСклада — единая подача во всех источниках.
                className="h-full min-h-14 w-full"
              />
            ) : (
              <EmptyState
                compact
                size="chart"
                title={snapshotDays ? 'Пока один снимок — линии ещё нет.' : 'Снимков ещё нет.'}
              />
            )}
          </ChartCardBody>
        )}
      </ChartWidget>

      {/* Состав базы на последний снимок. Кольцо не берём: доли обычно 90/8/2, и сектор в 2%
          нечитаем — строки переносят перекос спокойно и показывают точные числа. */}
      <ChartWidget id="rusender-base-mix" title="Состав базы" fixedSize="half" noStretch>
        {pending ? (
          <ChartSkeleton />
        ) : (
          <ChartCardBody
            value={formatByRole(contacts?.contacts_active ?? 0, 'headline')}
            caption="Активных контактов на последний снимок."
          >
            {/* Ширина ограничена: слот плота ~900px, и без потолка метка уезжала от значения
                почти на всю карточку — строку приходилось читать «через поле». */}
            <dl className="grid max-w-sm gap-y-2 text-sm">
              <MixRow label="Активные" value={contacts?.contacts_active ?? null} total={contacts?.contacts_total ?? null} />
              <MixRow label="Отписались" value={contacts?.contacts_unsubscribed ?? null} total={contacts?.contacts_total ?? null} />
              <MixRow label="Недоступны" value={contacts?.contacts_unavailable ?? null} total={contacts?.contacts_total ?? null} />
            </dl>
          </ChartCardBody>
        )}
      </ChartWidget>

      {/* Отписавшиеся — накопительный счётчик снимка, поэтому тоже уровень, а не поток. */}
      <ChartWidget
        id="rusender-unsub"
        title="Отписавшиеся"
        fixedSize="half"
        noStretch
        drillTo="/metrics/rusender-unsubscribed"
      >
        {pending ? (
          <ChartSkeleton />
        ) : (
          <ChartCardBody
            value={formatByRole(contacts?.contacts_unsubscribed ?? 0, 'headline')}
            caption="Накоплено в базе — уровень, не события дня"
          >
            {enoughDays ? (
              <div className="flex h-full min-h-0 flex-col">
                <ChartBand>
                  <BarChart values={model.unsub} labels={labels} axisLabels={axisLabels} />
                </ChartBand>
              </div>
            ) : (
              <EmptyState
                compact
                size="chart"
                title={snapshotDays ? 'Пока один снимок — ряда ещё нет.' : 'Снимков ещё нет.'}
              />
            )}
          </ChartCardBody>
        )}
      </ChartWidget>

      {/* Как и на «Обзоре», объяснение стоит ПОД карточками: длинная подпись у ChartCardBody
          вытесняет график (колонка числа `shrink-0`, плот `flex-1`). */}
      {!pending && (
        <p className="col-span-full text-xs text-muted-foreground">
          Истории размера базы у Rusender API нет — <b className="font-medium text-foreground">она копится
          с момента подключения</b>, и дорисовать прошлое нечем. День без снимка показан разрывом линии,
          а не нулём: это дыра в сборе, а не обнулившаяся база.
        </p>
      )}
    </WidgetGrid>
  );
}

/** Строка состава базы: число + доля от всей базы. */
function MixRow({ label, value, total }: { label: string; value: number | null; total: number | null }) {
  const share = value != null && total != null && total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '—';
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="truncate text-muted-foreground">{label}</dt>
      {/* Разделитель ОБЯЗАТЕЛЕН: на проде «903» и «97.6%» стояли через margin и читались одним
          числом «90397.6%». Точка-разделитель — тот же приём, что у «Мин · Макс» в леджере. */}
      <dd className="shrink-0 tabular-nums text-foreground">
        {value != null ? fmt.kpi(value) : '—'}
        <span className="ml-1.5 text-xs text-muted-foreground">
          <span aria-hidden="true" className="mr-1.5">·</span>
          {share}
        </span>
      </dd>
    </div>
  );
}
