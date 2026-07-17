import { useContext, useMemo, useState } from 'react';
import { useMsChannelSeries, useMsGeography, useMsSalesByChannel } from '@/api/queries';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { LineChart } from '@/components/LineChart';
import { PillSelect } from '@/components/PillSelect';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { lttbDownsample } from '@/lib/downsample';
import { fmt, pluralRu } from '@/lib/format';
import { usePagePeriod } from '@/lib/period';

/**
 * «Каналы» МойСклада (слайс 6) — откуда приходят продажи. salesChannel на заказе = источник
 * (сайт/директ/маркетплейс/самовывоз/соцсети): та самая ось, которую владелец хотел «настраивать
 * в графике, как у Steep». Плюс география доставки (город). Всё — из архива ms_orders дешёвыми
 * DB-агрегатами; имена каналов резолвит бэк словарём saleschannel. Свёрнутая карточка — топ,
 * разворот (ChartExpandedContext, канон Breakdown) — полный список.
 */
export function MsChannels() {
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  const windowLabel = days === 0 ? 'за всё время' : `за ${days} дн.`;
  const channels = useMsSalesByChannel(days);
  const geo = useMsGeography(days);
  // «настроить график по источнику» (запрос владельца, Steep-паттерн): выбранный канал фильтрует
  // дневную серию выручки. 'all' = все каналы (итог). Список каналов — из breakdown-ответа.
  const [pickedChannel, setPickedChannel] = useState<string>('all');
  // ВСЕ хуки — ДО любого early-return (канон React #310: условный вызов хука = краш).
  const channelOptions = useMemo(
    () => [
      { value: 'all', label: 'Все каналы' },
      ...(channels.data?.rows ?? []).map((r) => ({ value: r.sales_channel_id, label: r.name ?? 'Без имени' })),
    ],
    [channels.data],
  );

  if (channels.isError) {
    return (
      <ErrorState
        title="Не удалось получить каналы продаж"
        reason={channels.error instanceof Error ? channels.error.message : 'ошибка'}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <MsChannelDynamicsCard
        days={days}
        picked={pickedChannel}
        onPick={setPickedChannel}
        options={channelOptions}
      />

      <ChartWidget id="ms-channels" title={`Продажи по каналам ${windowLabel}`} fixedSize="full">
        {channels.isPending ? (
          <ListSkeleton rows={6} />
        ) : !channels.data || channels.data.rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет продаж за период.</p>
        ) : (
          <MsChannelRows
            rows={channels.data.rows}
            totalOrders={channels.data.total_orders}
            noChannel={channels.data.no_channel_orders}
          />
        )}
      </ChartWidget>

      <ChartWidget id="ms-geography" title={`География заказов ${windowLabel}`} fixedSize="half">
        {geo.isPending ? (
          <ListSkeleton rows={5} />
        ) : geo.isError || !geo.data || geo.data.rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет городов доставки за период.</p>
        ) : (
          <MsGeographyRows rows={geo.data.rows} noCity={geo.data.no_city_orders} totalOrders={geo.data.total_orders} />
        )}
      </ChartWidget>
    </div>
  );
}

const localDayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Календарная сетка окна нулями (бэк отдаёт только дни с заказами): выручка дня без заказов =
    честный ноль, не разрыв (это арифметика по архиву, а не пропуск сбора). Зеркало densifyDays
    на Клиентах — форма серии здесь своя ({day, sum}). */
function densifyRevenue(series: Array<{ day: string; sum: number }>, days: number): Array<{ day: string; sum: number }> {
  const today = new Date();
  let start: Date;
  if (days > 0) start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  else if (series.length > 0) {
    const [y, m, d] = series[0].day.split('-').map(Number);
    start = new Date(y, m - 1, d);
  } else return [];
  const byDay = new Map(series.map((r) => [r.day, r.sum]));
  const out: Array<{ day: string; sum: number }> = [];
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = localDayKey(d);
    out.push({ day: key, sum: byDay.get(key) ?? 0 });
  }
  return out;
}

/** Динамика выручки во времени с ФИЛЬТРОМ по каналу продаж — то самое «настраивать в графике
    какие показывать» из запроса владельца (Steep-паттерн). Переиспользует LineChart + PillSelect;
    сумма по дням из архива ms_orders, отфильтрованная выбранным каналом. */
function MsChannelDynamicsCard({
  days,
  picked,
  onPick,
  options,
}: {
  days: number;
  picked: string;
  onPick: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const series = useMsChannelSeries(days, picked === 'all' ? null : picked);
  const pickedLabel = options.find((o) => o.value === picked)?.label ?? 'Все каналы';
  const dense = series.data ? densifyRevenue(series.data.series, days) : [];
  const sampled = lttbDownsample(dense, 140, (r) => r.sum);
  const total = series.data ? series.data.series.reduce((acc, r) => acc + r.sum, 0) : 0;

  return (
    <ChartWidget id="ms-channel-series" title="Выручка по каналу" fixedSize="full">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-2xs text-muted-foreground">Канал:</span>
        <PillSelect ariaLabel="Канал продаж" value={picked} options={options} onValueChange={onPick} className="min-w-[10rem]" />
      </div>
      {series.isPending ? (
        <ListSkeleton rows={4} />
      ) : series.isError ? (
        <p className="py-4 text-sm text-muted-foreground">Не удалось получить динамику канала.</p>
      ) : sampled.length > 1 ? (
        <ChartCardBody value={`${fmt.short(total)} ₽`} caption={`${pickedLabel} · ${days === 0 ? 'за всё время' : `за ${days} дн.`}`}>
          <LineChart
            values={sampled.map((r) => r.sum)}
            labels={sampled.map((r) => fmt.day(r.day))}
            titles={sampled.map((r) => `${fmt.day(r.day)}: ${fmt.num(r.sum)} ₽`)}
            yMin={0}
          />
        </ChartCardBody>
      ) : (
        <p className="py-4 text-xs text-muted-foreground">
          Недостаточно данных по каналу за период. Если каналы пусты — запустите повторную загрузку истории на «Подключении».
        </p>
      )}
    </ChartWidget>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2 py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  );
}

// Тип канала МС → короткий русский ярлык (тихий, muted): группирует источники, не кричит.
const CHANNEL_TYPE_LABEL: Record<string, string> = {
  ECOMMERCE: 'Сайт',
  DIRECT_SALES: 'Прямые',
  MARKETPLACE: 'Маркетплейс',
  SOCIAL_NETWORK: 'Соцсети',
  OTHER: 'Другое',
};

/** Каналы продаж барами в акценте графиков по доле выручки; свёрнуто — топ-8, разворот — все.
    Строку без канала (sales_channel_id NULL) бэк выносит в noChannel — показываем сноской. */
function MsChannelRows({
  rows,
  totalOrders,
  noChannel,
}: {
  rows: Array<{ sales_channel_id: string; name: string | null; type: string | null; orders: number; sum: number }>;
  totalOrders: number;
  noChannel: number;
}) {
  const expanded = useContext(ChartExpandedContext);
  const shown = expanded ? rows : rows.slice(0, 8);
  const maxSum = rows[0]?.sum ?? 1;
  const restOrders = (expanded ? [] : rows.slice(8)).reduce((acc, r) => acc + r.orders, 0) + noChannel;
  return (
    <div className="space-y-2.5 pt-1">
      {shown.map((r) => (
        <div key={r.sales_channel_id}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-baseline gap-2 text-foreground">
              <span className="truncate">{r.name ?? 'Канал без имени'}</span>
              {r.type && CHANNEL_TYPE_LABEL[r.type] && (
                <span className="shrink-0 text-2xs text-muted-foreground">{CHANNEL_TYPE_LABEL[r.type]}</span>
              )}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{fmt.short(r.sum)} ₽</span> · {fmt.num(r.orders)}{' '}
              {pluralRu(r.orders, ['заказ', 'заказа', 'заказов'])}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(3, Math.round((r.sum / maxSum) * 100))}%`,
                backgroundColor: 'hsl(var(--chart-role-primary) / 0.75)',
              }}
            />
          </div>
        </div>
      ))}
      {restOrders > 0 && (
        <p className="text-2xs text-muted-foreground">
          {expanded ? 'Из них' : 'Ещё'} {fmt.num(restOrders)}{' '}
          {noChannel > 0 ? `заказов (без канала ${fmt.num(noChannel)})` : 'заказов'} из {fmt.num(totalOrders)}.
        </p>
      )}
    </div>
  );
}

/** Топ городов доставки: строки-бары по числу заказов; разворот — все города. Города без
    доставки (самовывоз/не указан) — честной сноской, не растворены. */
function MsGeographyRows({
  rows,
  noCity,
  totalOrders,
}: {
  rows: Array<{ city: string; orders: number; sum: number }>;
  noCity: number;
  totalOrders: number;
}) {
  const expanded = useContext(ChartExpandedContext);
  const shown = expanded ? rows : rows.slice(0, 6);
  const maxOrders = rows[0]?.orders ?? 1;
  return (
    <div className="space-y-2.5 pt-1">
      {shown.map((r) => (
        <div key={r.city}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-foreground">{r.city}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{fmt.num(r.orders)}</span> · {fmt.short(r.sum)} ₽
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(3, Math.round((r.orders / maxOrders) * 100))}%`,
                backgroundColor: 'hsl(var(--chart-role-primary) / 0.75)',
              }}
            />
          </div>
        </div>
      ))}
      {noCity > 0 && (
        <p className="text-2xs text-muted-foreground">
          Без города доставки (самовывоз / не указан): {fmt.num(noCity)} из {fmt.num(totalOrders)}.
        </p>
      )}
    </div>
  );
}
