import { useMemo, useState } from 'react';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { EmptyState } from '@/components/EmptyState';
import { SearchField } from '@/components/SearchField';
import { ErrorState } from '@/components/ErrorState';
import { TableSkeleton } from '@/components/ui/dataSkeleton';
import { useCdekHourly, useCdekOrders, type CdekOrder } from '@/api/cdek';
import { CdekOrderFilter } from '@/panels/cdek/CdekPicker';
import {
  CDEK_CANON_STATUSES,
  CDEK_SALES_CHANNELS,
  CDEK_STATUSES,
  cdekStatusInclude,
  cdekStatusLabel,
} from '@/panels/cdek/cdekStatusFilter';
import { useVirtualRows } from '@/lib/useVirtualRows';
import { useScrollEdgeFade } from '@/lib/useScrollEdgeFade';
import { fmt } from '@/lib/format';
import { formatMoney } from '@/lib/metricNumber';
import { useCardShowsPeriod, usePagePeriod } from '@/lib/period';
import { useMsPagePeriod } from '@/lib/msPeriod';
import { plural } from '@/lib/narrative';
import { cn } from '@/lib/utils';

/**
 * «Заказы» СДЭКа — рабочая лента склада: найти конкретную посылку и понять ритм спроса.
 *
 * Поиск идёт по номеру заказа, внешнему номеру маркетплейса и трек-номеру, потому что именно
 * их приносит человек («где посылка 10145274548?»). Трек есть только у своей доставки, внешний
 * номер — только у маркетплейсов, поэтому искать надо по всем трём сразу, а не выбирать поле.
 */

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;

const CHANNEL_LABEL: Record<string, string> = {
  own: 'Своя доставка',
  wildberries: 'Wildberries',
  yandex_market: 'Яндекс.Маркет',
  ozon: 'Ozon',
  other: 'Другая служба',
};

/** Лента заказов — таблица: за суммой заказа идут именно сюда, роль `exact`. */
const rub = (n: number | null) => formatMoney(n, 'exact');

export function CdekOrders() {
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  const period = useMsPagePeriod();
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
  const periodInLabel = useCardShowsPeriod() ? windowLabel : undefined;

  const [channels, setChannels] = useState<string[]>([]);
  // ФИЛЬТР СТАРТУЕТ С КАНОНА, а не с пустоты. Пустой набор на сервере означает «только отгруженное»
  // (завершён + в доставке), то есть лента и раньше показывала два статуса из шести — но кнопка при
  // этом выглядела невыбранной, без числа и подсветки, и читалась как «фильтра нет». Человек искал
  // отменённый заказ по верному номеру, получал «Ничего не нашлось» и совет проверить номер —
  // совет заведомо бесполезный. Теперь состояние видно: «Статусы · 2», и первый выбор ДОБАВЛЯЕТ
  // статус к видимым, а не подменяет ленту целиком.
  const [statuses, setStatuses] = useState<string[]>([...CDEK_CANON_STATUSES]);
  const [q, setQ] = useState('');

  // Выбранные статусы едут через `include` — тем же каноном, что и на метриках (cdekStatusInclude):
  // пусто → отгруженное, набор → ровно он, все шесть → «все». Отдельным полем они ложились ПОВЕРХ
  // канона, и «Возврат» давал всегда пустую ленту: «статус равен return И не равен return».
  // Почасовой профиль ходит с тем же include — иначе карточка «Когда покупают» считала бы другой
  // набор заказов, чем таблица под ней.
  const include = cdekStatusInclude(statuses);
  const hourly = useCdekHourly(period, include);
  const orders = useCdekOrders(period, { channel: channels, q: q || undefined }, include);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartWidget id="cdek-rhythm" title={`Когда покупают ${periodInLabel ?? ''}`.trim()} fixedSize="full">
        {hourly.isPending ? (
          <TableSkeleton rows={7} columns={12} />
        ) : hourly.isError ? (
          <ErrorState compact size="chart" title="Не удалось получить ритм заказов" onRetry={() => hourly.refetch()} />
        ) : (
          <RhythmHeatmap cells={hourly.data?.cells ?? []} />
        )}
      </ChartWidget>

      <ChartWidget id="cdek-orders-list" title={`Заказы ${periodInLabel ?? ''}`.trim()} fixedSize="full">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {/* ОБЩЕЕ ПОЛЕ ПОИСКА, а не восьмая рукописная копия: лупа, крестик очистки, Escape и
              счётчик результатов для скринридера приходят из канона. Своя сборка из голого input
              не имела ничего из этого — и на телефоне схлопывалась до 43 пикселей, потому что
              делила строку с двумя кнопками фильтров: в поле помещался ровно курсор, а плейсхолдер
              «Номер заказа, внешний номер или трек» не читался вовсе. Теперь на узком экране поле
              занимает свою строку целиком. */}
          <SearchField
            id="cdek-order-search"
            className="w-full sm:w-72"
            value={q}
            onChange={setQ}
            placeholder="Номер заказа, внешний номер или трек"
            ariaLabel="Поиск заказа"
            resultsLabel={
              orders.data ? `${orders.data.total} ${plural(orders.data.total, 'заказ', 'заказа', 'заказов')}` : undefined
            }
          />
          {/* Те же оси и те же значения, что в развороте метрики: набор, а не одиночный выбор, и
              список ВЫВОДИТСЯ из канона источника. Прежние сегменты жили своей жизнью — четыре
              канала из пяти (без «Другой службы») с сокращёнными подписями «Своя»/«WB»/«ЯМ» и два
              статуса из шести. Заказ со статусом «Возврат» было нечем найти вовсе. */}
          <CdekOrderFilter
            label="Каналы продаж"
            // «Без канала» — свой вариант, а не «Другая служба»: у таких заказов служба доставки в
            // выгрузке пуста, разбивка показывает их отдельной группой, и таблица подписывает строку
            // так же. Без этого варианта их было НЕ НАЙТИ ни одним чипом.
            options={[...CDEK_SALES_CHANNELS, { id: 'none', label: 'Без канала' }]}
            selected={channels}
            onChange={setChannels}
          />
          <CdekOrderFilter
            label="Статусы"
            options={CDEK_STATUSES}
            selected={statuses}
            onChange={setStatuses}
          />
        </div>
        {orders.isPending ? (
          <TableSkeleton rows={8} columns={6} />
        ) : orders.isError ? (
          <ErrorState compact size="table" title="Не удалось получить заказы" onRetry={() => orders.refetch()} />
        ) : (orders.data?.orders.length ?? 0) === 0 ? (
          <EmptyState
            compact
            size="table"
            title={q ? 'Ничего не нашлось' : 'Нет заказов за период.'}
            // Пустая лента ОБЯЗАНА назвать действующий фильтр: искомый заказ может лежать под
            // снятым статусом или каналом, и совет «проверьте номер» уводил в сторону от причины.
            reason={
              [
                q ? 'Поиск идёт по номеру заказа, внешнему номеру и трек-номеру.' : null,
                statuses.length > 0 && statuses.length < CDEK_STATUSES.length
                  ? `Считаются только: ${statuses
                      .map((id) => CDEK_STATUSES.find((x) => x.id === id)?.label ?? id)
                      .join(', ')
                      .toLocaleLowerCase('ru-RU')}.`
                  : null,
                channels.length > 0 && channels.length < CDEK_SALES_CHANNELS.length
                  ? `Каналы: ${channels
                      .map((id) => CDEK_SALES_CHANNELS.find((x) => x.id === id)?.label ?? id)
                      .join(', ')}.`
                  : null,
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
          />
        ) : (
          <OrdersTable
            rows={orders.data?.orders ?? []}
            total={orders.data?.total ?? 0}
            truncated={orders.data?.truncated ?? false}
          />
        )}
      </ChartWidget>
    </div>
  );
}

/**
 * Ритм: день недели × час. Считается по заказам — многострочный заказ оформлен один раз.
 * Интенсивность — доля от самого горячего часа; пустая клетка означает «заказов не было».
 */
function RhythmHeatmap({ cells }: { cells: Array<{ weekday: number; hour: number; orders: number }> }) {
  const scrollFadeRef = useScrollEdgeFade<HTMLDivElement>();
  const model = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    let max = 0;
    let best: { weekday: number; hour: number; orders: number } | null = null;
    for (const c of cells) {
      const wd = c.weekday - 1;
      if (wd < 0 || wd > 6 || c.hour < 0 || c.hour > 23) continue;
      grid[wd][c.hour] = c.orders;
      if (c.orders > max) {
        max = c.orders;
        best = { weekday: wd, hour: c.hour, orders: c.orders };
      }
    }
    return { grid, max, best, total: cells.reduce((s, c) => s + c.orders, 0) };
  }, [cells]);

  if (model.total === 0) {
    return <EmptyState compact size="chart" title="Нет заказов за период." />;
  }

  const label = model.best
    ? `Пик: ${DAY_NAMES[model.best.weekday]} в ${String(model.best.hour).padStart(2, '0')}:00 — ${fmt.num(model.best.orders)} зак.`
    : '';

  return (
    <div>
      <div ref={scrollFadeRef} className="scroll-fade-x overflow-x-auto pb-2">
        <div className="min-w-[560px]">
          <div className="mb-1 grid gap-[2px] pl-8 text-2xs text-muted-foreground" style={{ gridTemplateColumns: 'repeat(24, minmax(14px, 1fr))' }}>
            {Array.from({ length: 24 }, (_, h) => (
              // Подписываем каждый третий час: 24 подписи в ряд не читаются.
              <div key={h} className="text-center">{h % 3 === 0 ? h : ''}</div>
            ))}
          </div>
          {model.grid.map((row, wd) => (
            <div key={DAY_NAMES[wd]} className="mb-[2px] flex items-center gap-[2px]">
              <div className="w-8 shrink-0 text-2xs text-muted-foreground">{DAY_NAMES[wd]}</div>
              <div className="grid flex-1 gap-[2px]" style={{ gridTemplateColumns: 'repeat(24, minmax(14px, 1fr))' }}>
                {row.map((n, h) => (
                  <div
                    key={h}
                    title={`${DAY_NAMES[wd]} ${String(h).padStart(2, '0')}:00 — ${fmt.num(n)} зак.`}
                    className={cn('h-4 rounded-[2px]', n === 0 ? 'bg-muted/40' : 'bg-primary')}
                    // Непрерывная шкала от доли максимума: пять ступеней здесь врали бы про
                    // равномерность, а заказов в клетке единицы.
                    style={n === 0 ? undefined : { opacity: 0.2 + 0.8 * (n / model.max) }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {label && <p className="mt-2 text-2xs text-muted-foreground">{label}</p>}
    </div>
  );
}

function OrdersTable({ rows, total, truncated }: { rows: CdekOrder[]; total: number; truncated: boolean }) {
  // Оценка ~41px: одна строка + py-2 + hairline. Виртуализация включается сама на длинной ленте.
  const virtual = useVirtualRows<HTMLTableSectionElement>({ count: rows.length, estimateSize: 41 });

  const cells = (row: CdekOrder) => (
    <>
      <td className="whitespace-nowrap font-medium">{row.order_id}</td>
      <td className="whitespace-nowrap text-muted-foreground">{row.created_at ? fmt.date(row.created_at) : '—'}</td>
      <td className="whitespace-nowrap">{cdekStatusLabel(row.status)}</td>
      <td className="whitespace-nowrap text-muted-foreground">
        {row.channel ? (CHANNEL_LABEL[row.channel] ?? row.channel) : 'Без канала'}
      </td>
      {/* Трек есть только у своей доставки, внешний номер — только у маркетплейсов: показываем
          то, что у заказа реально есть, а не пустую колонку под каждый случай. */}
      <td className="whitespace-nowrap text-muted-foreground">{row.track_number || row.external_order_id || '—'}</td>
      <td className="text-right tabular-nums">{fmt.num(row.items)}</td>
      <td className="text-right tabular-nums">{rub(row.amount)}</td>
    </>
  );

  return (
    <div className="data-table-scroll">
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            <th scope="col" className="text-left">Заказ</th>
            <th scope="col" className="text-left">Создан</th>
            <th scope="col" className="text-left">Статус</th>
            <th scope="col" className="text-left">Канал</th>
            <th scope="col" className="text-left">Трек / внешний №</th>
            <th scope="col" className="text-right">Штук</th>
            <th scope="col" className="text-right">Сумма</th>
          </tr>
        </thead>
        {/* Виртуализация РАСПОРКАМИ, а не абсолютным позиционированием: `<tr>` остаётся
            `table-row` и держит колонки шапки. Прежний вариант ставил строке `display: table`,
            и каждая строка становилась своей таблицей — на живых данных ячейки схлопывались в
            20px и наезжали друг на друга, пока шапка держала настоящие ширины. */}
        <tbody ref={virtual.containerRef} data-virtualized={virtual.active ? 'true' : undefined}>
          {virtual.padTop > 0 && <tr style={{ height: virtual.padTop }} />}
          {(virtual.active ? virtual.items.map((vi) => [rows[vi.index], vi.index] as const) : rows.map((row, i) => [row, i] as const)).map(
            ([row, index]) =>
              row ? (
                <tr
                  key={row.order_id}
                  data-index={index}
                  ref={virtual.active ? virtual.measureElement : undefined}
                >
                  {cells(row)}
                </tr>
              ) : null,
          )}
          {virtual.padBottom > 0 && <tr style={{ height: virtual.padBottom }} />}
        </tbody>
      </table>
      <p className="mt-2 text-2xs text-muted-foreground">
        {truncated
          ? `Показаны первые ${fmt.num(rows.length)} заказов окна — сузьте период или фильтр.`
          : `Заказов в окне: ${fmt.num(total)}`}
      </p>
    </div>
  );
}
