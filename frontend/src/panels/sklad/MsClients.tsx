import { useContext } from 'react';
import { useMsCohorts, useMsCustomers, useMsTopCustomers } from '@/api/queries';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { LineChart } from '@/components/LineChart';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { lttbDownsample } from '@/lib/downsample';
import { fmt, pluralRu } from '@/lib/format';
import { usePagePeriod } from '@/lib/period';

/**
 * «Клиенты» МойСклада — покупательская аналитика АРХИВА заказов (ms_orders, слайс 3).
 * Семантика пришпилена на бэке: «новый» заказ = первый заказ этого контрагента за всю историю
 * канала (не окна), поэтому цифры не скачут при смене периода. Заказы без контрагента честно
 * вынесены в сноску, а не растворены в числах.
 */
export function MsClients() {
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  const windowLabel = days === 0 ? 'за всё время' : `за ${days} дн.`;
  const customers = useMsCustomers(days);
  const cohorts = useMsCohorts();
  const topCustomers = useMsTopCustomers(days);

  if (customers.isPending) {
    return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-[264px] rounded-2xl border border-border bg-card p-5 lg:col-span-3">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="mt-3 h-40 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (customers.isError) {
    return (
      <ErrorState
        title="Не удалось получить данные о покупателях"
        reason={customers.error instanceof Error ? customers.error.message : 'ошибка'}
      />
    );
  }

  const { summary, series } = customers.data;
  // Бэк отдаёт только дни С заказами (канон mentions.daily) — дозаполняем календарную сетку окна
  // нулями: день без заказов для СЧЁТЧИКА заказов — честный ноль, а не разрыв (разрыв = пропуск
  // сбора, здесь сбора нет — есть арифметика по архиву). Затем длинные окна («Всё» = годы точек)
  // даунсэмплим по канону графиков; обе серии на одной сетке — один LTTB-проход по сумме дня.
  const dense = densifyDays(series, days);
  const sampled = lttbDownsample(dense, 140, (r) => r.new_orders + r.repeat_orders);
  const labels = sampled.map((r) => fmt.day(r.day));
  const newValues = sampled.map((r) => r.new_orders);
  const repeatValues = sampled.map((r) => r.repeat_orders);
  const repeatShare = summary.customers > 0 ? Math.round((summary.repeat_customers / summary.customers) * 100) : 0;
  const everShare = summary.repeat_ever; // клиенты с ≥2 заказами за всю историю

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartWidget id="ms-customers" title="Покупатели" fixedSize="half">
        <ChartCardBody value={fmt.num(summary.customers)} caption={windowLabel}>
          {sampled.length > 1 ? (
            <LineChart
              values={newValues}
              ghost={repeatValues}
              primaryLabel="Новые"
              ghostLabel="Повторные"
              labels={labels}
              yMin={0}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Недостаточно дней для графика.</p>
          )}
        </ChartCardBody>
      </ChartWidget>

      <ChartWidget id="ms-repeat" title="Повторные покупки" fixedSize="half">
        {days === 0 ? (
          // На «Всё» окно совпадает с историей — «новых в окне» не бывает; честная метрика
          // здесь — сколько клиентов вообще возвращалось.
          <ChartCardBody
            value={`${summary.customers > 0 ? Math.round((everShare / summary.customers) * 100) : 0}%`}
            caption={`возвращались: ${fmt.num(everShare)} из ${fmt.num(summary.customers)} клиентов`}
          >
            <MsRepeatBreakdown summary={summary} allTime />
          </ChartCardBody>
        ) : (
          <ChartCardBody
            value={`${repeatShare}%`}
            caption={`повторных покупателей ${windowLabel}`}
          >
            <MsRepeatBreakdown summary={summary} />
          </ChartCardBody>
        )}
      </ChartWidget>

      <MsTopCustomersCard state={topCustomers} windowLabel={windowLabel} />

      <MsCohortsCard state={cohorts} />
    </div>
  );
}

/** Топ покупателей окна по выручке (слайс 4): имена резолвит бэк словарём counterparty по id;
    удалённый/безымянный контрагент честно показывается заглушкой, а не выпадает из топа. */
function MsTopCustomersCard({
  state,
  windowLabel,
}: {
  state: ReturnType<typeof useMsTopCustomers>;
  windowLabel: string;
}) {
  return (
    <ChartWidget id="ms-top-customers" title={`Топ покупателей ${windowLabel}`} fixedSize="full">
      {state.isPending ? (
        <div className="space-y-2 py-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={`tc${i}`} className="h-6 w-full" />
          ))}
        </div>
      ) : state.isError || !state.data || state.data.rows.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">Нет покупателей за период.</p>
      ) : (
        <ul>
          {state.data.rows.map((row, i) => (
            <li key={row.agent_id} className="flex items-center gap-3 border-t border-border py-2.5 first:border-t-0">
              <span className="w-5 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">{i + 1}</span>
              <span className={`min-w-0 flex-1 truncate text-sm ${row.name ? 'text-foreground' : 'text-muted-foreground'}`}>
                {row.name ?? 'Без имени'}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {fmt.num(row.orders)} {pluralRu(row.orders, ['заказ', 'заказа', 'заказов'])}
              </span>
              <span className="w-28 shrink-0 text-right text-sm font-medium tabular-nums">{fmt.short(row.sum)} ₽</span>
            </li>
          ))}
        </ul>
      )}
    </ChartWidget>
  );
}

function MsRepeatBreakdown({
  summary,
  allTime = false,
}: {
  summary: {
    new_customers: number;
    repeat_customers: number;
    orders_repeat: number;
    sum_repeat: number;
    no_agent_orders: number;
  };
  allTime?: boolean;
}) {
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      {!allTime && (
        <p>
          Новых <span className="font-medium tabular-nums text-foreground">{fmt.num(summary.new_customers)}</span> ·
          повторных <span className="font-medium tabular-nums text-foreground">{fmt.num(summary.repeat_customers)}</span>
        </p>
      )}
      <p>
        Повторные заказы: <span className="font-medium tabular-nums text-foreground">{fmt.num(summary.orders_repeat)}</span>{' '}
        на <span className="font-medium tabular-nums text-foreground">{fmt.short(summary.sum_repeat)} ₽</span>
      </p>
      {summary.no_agent_orders > 0 && (
        // Честная сноска вместо тихого искажения: заказы без контрагента в клиентские метрики
        // не входят (некому приписать повторность).
        <p className="text-2xs">Без контрагента: {fmt.num(summary.no_agent_orders)} заказов — не учтены.</p>
      )}
    </div>
  );
}

type MsDayPoint = { day: string; new_orders: number; repeat_orders: number };

const localDayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Календарная сетка окна: от sinceDay бэка (сегодня−(days−1), локальные дни — зеркало
    sinceDayOf роута) до сегодня; на «Всё» (0) — от первого дня серии. */
function densifyDays(series: MsDayPoint[], days: number): MsDayPoint[] {
  const today = new Date();
  let start: Date;
  if (days > 0) {
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  } else if (series.length > 0) {
    const [y, m, d] = series[0].day.split('-').map(Number);
    start = new Date(y, m - 1, d);
  } else {
    return [];
  }
  const byDay = new Map(series.map((r) => [r.day, r]));
  const out: MsDayPoint[] = [];
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = localDayKey(d);
    const row = byDay.get(key);
    out.push({ day: key, new_orders: row?.new_orders ?? 0, repeat_orders: row?.repeat_orders ?? 0 });
  }
  return out;
}

const COHORT_OFFSETS = Array.from({ length: 12 }, (_, i) => i);

/** Порядковый номер месяца 'YYYY-MM' (для границы «прошлое/будущее» в клетках когорт). */
function monthIndex(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return y * 12 + (mo - 1);
}

function cohortMonthLabel(m: string) {
  return new Date(`${m}-01T00:00:00`)
    .toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' })
    .replace(' г.', '');
}

function MsCohortsCard({ state }: { state: ReturnType<typeof useMsCohorts> }) {
  return (
    <ChartWidget id="ms-cohorts" title="Когорты: возвращаемость по месяцу первой покупки" fixedSize="full">
      {state.isPending ? (
        <div className="space-y-2 py-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={`c${i}`} className="h-6 w-full" />
          ))}
        </div>
      ) : state.isError || !state.data || state.data.cohorts.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          Когорт пока нет — они появятся после загрузки истории заказов.
        </p>
      ) : (
        <MsCohortsTable cohorts={state.data.cohorts} />
      )}
    </ChartWidget>
  );
}

/** Таблица когорт — ОТДЕЛЬНЫМ компонентом внутри детей карточки: ChartExpandedContext провайдится
    оверлеем разворота ВОКРУГ детей, поэтому читать его можно только отсюда (чтение в MsCohortsCard
    видело бы вечный false). Разворот показывает все когорты, свёрнуто — последние 12. */
function MsCohortsTable({
  cohorts,
}: {
  cohorts: Array<{ cohort_month: string; size: number; cells: Array<{ offset: number; active: number }> }>;
}) {
  const expanded = useContext(ChartExpandedContext);
  return (
    <>
      {/* Широкая матрица скроллится ВНУТРИ карточки (канон: без горизонтального overflow
          страницы; мобильное поведение не ломаем). */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-separate border-spacing-0 text-xs tabular-nums">
          <thead>
            <tr className="text-2xs text-muted-foreground">
              <th className="py-1.5 pr-3 text-left font-medium">Первая покупка</th>
              <th className="py-1.5 pr-3 text-right font-medium">Клиентов</th>
              {COHORT_OFFSETS.map((o) => (
                <th key={o} className="w-12 py-1.5 text-center font-medium">
                  {o === 0 ? '0' : `+${o}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(expanded ? cohorts : cohorts.slice(-12)).map((c) => {
                  const byOffset = new Map(c.cells.map((cell) => [cell.offset, cell.active]));
                  const now = new Date();
                  // Сколько offset-месяцев когорты уже НАСТУПИЛО: прошедший месяц без заказов —
                  // честный 0%, будущий — пустая клетка (данных ещё нет, не ноль).
                  const elapsed = now.getFullYear() * 12 + now.getMonth() - monthIndex(c.cohort_month);
                  return (
                    <tr key={c.cohort_month}>
                      <td className="whitespace-nowrap border-t border-border py-1.5 pr-3 text-left text-muted-foreground">
                        {cohortMonthLabel(c.cohort_month)}
                      </td>
                      <td className="border-t border-border py-1.5 pr-3 text-right font-medium text-foreground">
                        {fmt.num(c.size)}
                      </td>
                      {COHORT_OFFSETS.map((o) => {
                        if (o > elapsed || c.size === 0) {
                          return <td key={o} className="border-t border-border" />;
                        }
                        const active = byOffset.get(o) ?? 0;
                        const share = active / c.size;
                        return (
                          <td key={o} className="border-t border-border p-0.5 text-center">
                            <span
                              className="block rounded px-1 py-1 text-foreground"
                              style={{ backgroundColor: `hsl(var(--chart-role-primary) / ${(share * 0.45).toFixed(3)})` }}
                              title={`${fmt.num(active)} из ${fmt.num(c.size)} клиентов`}
                            >
                              {Math.round(share * 100)}%
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-2xs text-muted-foreground">
        Доля клиентов когорты, сделавших заказ через N месяцев после первой покупки; «0» — месяц самой первой
        покупки.
      </p>
    </>
  );
}
