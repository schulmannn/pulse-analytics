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
import { usePagePeriod } from '@/lib/period';

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
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  const summary = useRusenderSummary(channelId, days, rusenderSurfaces);

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
  const enoughDays = model.days.length > 1;
  const pending = summary.isPending;

  return (
    <>
      {/* Размер базы — УРОВЕНЬ, а не поток: линия. Столбцы намекали бы, что дни складываются. */}
      <ChartWidget id="rusender-base-total" title="Размер базы" fixedSize="half" defaultColor={1} defaultTinted>
        {pending ? (
          <ChartSkeleton />
        ) : (
          <ChartCardBody
            value={formatByRole(contacts?.contacts_total ?? 0, 'headline')}
            caption={
              contacts?.day
                ? `Снимок на ${fmt.date(contacts.day)}. История копится с момента подключения — у Rusender API её нет, дорисовать прошлое нечем.`
                : 'Снимок базы ещё не снят.'
            }
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
              />
            ) : (
              <EmptyState compact size="chart" title="Пока один снимок — линии ещё нет." />
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
            <dl className="grid gap-y-2 text-sm">
              <MixRow label="Активные" value={contacts?.contacts_active ?? null} total={contacts?.contacts_total ?? null} />
              <MixRow label="Отписались" value={contacts?.contacts_unsubscribed ?? null} total={contacts?.contacts_total ?? null} />
              <MixRow label="Недоступны" value={contacts?.contacts_unavailable ?? null} total={contacts?.contacts_total ?? null} />
            </dl>
          </ChartCardBody>
        )}
      </ChartWidget>

      {/* Отписавшиеся — накопительный счётчик снимка, поэтому тоже уровень, а не поток. */}
      <ChartWidget id="rusender-unsub" title="Отписавшиеся" fixedSize="half" noStretch>
        {pending ? (
          <ChartSkeleton />
        ) : (
          <ChartCardBody
            value={formatByRole(contacts?.contacts_unsubscribed ?? 0, 'headline')}
            caption="Накопленное число отписавшихся в базе на день снимка — это уровень, а не события дня."
          >
            {enoughDays ? (
              <div className="flex h-full min-h-0 flex-col">
                <ChartBand>
                  <BarChart values={model.unsub} labels={labels} axisLabels={axisLabels} />
                </ChartBand>
              </div>
            ) : (
              <EmptyState compact size="chart" title="Пока один снимок — ряда ещё нет." />
            )}
          </ChartCardBody>
        )}
      </ChartWidget>
    </>
  );
}

/** Строка состава базы: число + доля от всей базы. */
function MixRow({ label, value, total }: { label: string; value: number | null; total: number | null }) {
  const share = value != null && total != null && total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '—';
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="shrink-0 tabular-nums text-foreground">
        {value != null ? fmt.kpi(value) : '—'}
        <span className="ml-1 text-xs text-muted-foreground">{share}</span>
      </dd>
    </div>
  );
}
