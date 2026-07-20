import { useMemo } from 'react';
import { useMsStock, type MsStockRow } from '@/api/queries';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/lib/format';
import type { MsPeriod } from '@/lib/msPeriod';

/**
 * «Остатки» — «что заканчивается»: живой отчёт остатков склада, обогащённый скоростью продаж
 * выбранного окна (сервер: /api/ms/stock). Тот же паттерн, что MsTopProducts: компактная карточка
 * (топ-5 по срочности) на Обзоре + полная таблица на `/metrics/ms-stock`. Сервер сортирует по
 * days_left ASC NULLS LAST → stock ASC и отдаёт первые 200 позиций; days_left=null — товар без
 * продаж за окно («нет продаж», не бесконечность). Окну ОБЯЗАН быть конечный знаменатель:
 * «Всё» (период без границ) подменяется 30-дневным пресетом ({@link msStockPeriod}).
 */

// 4, не 5: тайл делит 264px с рядом период-пилюль — пятая строка выпирала за overflow-hidden
// (ловится e2e ms-compact-lists overflowingCards).
const COMPACT_ROWS = 4;
/** Порог «скоро кончится»: остатка меньше чем на неделю продаж → каноничный warning-токен. */
const WARN_DAYS_LEFT = 7;

export type MsStockSort = 'days' | 'stock' | 'sold';

export const STOCK_SORT_OPTIONS: Array<{ value: MsStockSort; content: string }> = [
  { value: 'days', content: 'Дней до нуля' },
  { value: 'stock', content: 'Остаток' },
  { value: 'sold', content: 'Продано' },
];

/** Конечное окно запроса остатков: скорости продаж нужен знаменатель, поэтому неограниченное
    «Всё» подменяется 30-дневным пресетом (days=0 сервер честно отвечает 400). */
export function msStockPeriod(period: MsPeriod): MsPeriod {
  return period.from && period.to ? period : { days: 30 };
}

/** «~K дн.» до нуля остатка: K округляется, ≥100 сжимается в «100+ дн.», null → «нет продаж». */
export function fmtDaysLeft(daysLeft: number | null): string {
  if (daysLeft == null) return 'нет продаж';
  if (daysLeft >= 100) return '100+ дн.';
  return `~${fmt.num(Math.round(daysLeft))} дн.`;
}

const isWarnRow = (row: MsStockRow): boolean => row.days_left != null && row.days_left <= WARN_DAYS_LEFT;

// Стабильные ключи скелетона (канон MsRfmCustomers.SKELETON_ROWS — без index-key).
const SKELETON_KEYS = ['st1', 'st2', 'st3', 'st4', 'st5', 'st6', 'st7', 'st8'];

function StockSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2 py-2">
      {SKELETON_KEYS.slice(0, rows).map((key) => (
        <Skeleton key={key} className="h-6 w-full" />
      ))}
    </div>
  );
}

function StockError({ state }: { state: ReturnType<typeof useMsStock> }) {
  return (
    <ErrorState
      className="py-4"
      title="Не удалось получить остатки"
      reason={state.error instanceof Error ? state.error.message : 'ошибка'}
      onRetry={() => state.refetch()}
      retrying={state.isFetching}
    />
  );
}

/** Компактная карточка Обзора: топ-5 самых срочных позиций «имя · N шт · ~K дн.». Позиции с
    остатком меньше недели продаж подсвечены каноничным warning-токеном (text-status-warn). */
export function MsStockCard({ period }: { period: MsPeriod }) {
  const stock = useMsStock(msStockPeriod(period));
  if (stock.isPending) return <StockSkeleton rows={COMPACT_ROWS} />;
  if (stock.isError) return <StockError state={stock} />;
  const rows = stock.data?.rows ?? [];
  if (rows.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">Остатки недоступны.</p>;
  }
  return (
    <>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-2xs text-muted-foreground">Что заканчивается</span>
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
          скорость за {fmt.num(stock.data.window_days)} дн.
        </span>
      </div>
      <ul>
        {rows.slice(0, COMPACT_ROWS).map((row, i) => {
          const warn = isWarnRow(row);
          return (
            <li
              key={row.id ?? `${row.name}-${i}`}
              className="flex items-center gap-3 border-t border-border py-1 first:border-t-0"
            >
              <span
                title={row.name ?? undefined}
                className="min-w-0 flex-1 truncate text-sm text-foreground"
              >
                {row.name ?? 'Товар без имени'}
              </span>
              <span
                className={`shrink-0 whitespace-nowrap text-right text-xs tabular-nums ${
                  warn ? 'font-medium text-status-warn' : 'text-muted-foreground'
                }`}
              >
                {fmt.num(row.stock)} шт · {fmtDaysLeft(row.days_left)}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Полная таблица `/metrics/ms-stock`: все строки ответа (имя / остаток / резерв / продано за окно /
 * ~дней до нуля). Сортировка по срочности (days_left, серверный порядок) по умолчанию; «Остаток» —
 * ASC (наименьший запас первым), «Продано» — DESC. Широкая таблица скроллится ВНУТРИ карточки
 * (канон: без горизонтального overflow страницы).
 */
export function MsStockTable({ period, sort }: { period: MsPeriod; sort: MsStockSort }) {
  const stock = useMsStock(msStockPeriod(period));
  const rows = stock.data?.rows;
  const sorted = useMemo(() => {
    if (!rows) return [];
    if (sort === 'stock') return [...rows].sort((a, b) => a.stock - b.stock);
    if (sort === 'sold') return [...rows].sort((a, b) => b.sold_window - a.sold_window);
    return rows; // серверный порядок: days_left ASC NULLS LAST → stock ASC
  }, [rows, sort]);
  if (stock.isPending) return <StockSkeleton rows={8} />;
  if (stock.isError) return <StockError state={stock} />;
  if (!rows || rows.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">Остатки недоступны.</p>;
  }
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-0 text-sm tabular-nums">
          <thead>
            <tr className="text-2xs text-muted-foreground">
              <th className="py-1.5 pr-3 text-left font-medium">Товар</th>
              <th className="py-1.5 pr-3 text-right font-medium">Остаток</th>
              <th className="py-1.5 pr-3 text-right font-medium">Резерв</th>
              <th className="py-1.5 pr-3 text-right font-medium">Продано за окно</th>
              <th className="py-1.5 text-right font-medium">~Дней до нуля</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => {
              const warn = isWarnRow(row);
              return (
                <tr key={row.id ?? `${row.name}-${i}`}>
                  <td className="max-w-[280px] truncate border-t border-border py-1.5 pr-3 text-left text-foreground" title={row.name ?? undefined}>
                    {row.name ?? 'Товар без имени'}
                  </td>
                  <td className="border-t border-border py-1.5 pr-3 text-right text-foreground">{fmt.num(row.stock)}</td>
                  <td className="border-t border-border py-1.5 pr-3 text-right text-muted-foreground">{fmt.num(row.reserve)}</td>
                  <td className="border-t border-border py-1.5 pr-3 text-right text-muted-foreground">{fmt.num(row.sold_window)}</td>
                  <td
                    className={`whitespace-nowrap border-t border-border py-1.5 text-right ${
                      warn ? 'font-medium text-status-warn' : row.days_left == null ? 'text-muted-foreground' : 'text-foreground'
                    }`}
                  >
                    {fmtDaysLeft(row.days_left)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-2xs text-muted-foreground">
        Скорость продаж — по выбранному окну ({fmt.num(stock.data.window_days)} дн.); «нет продаж» —
        за окно не продано ни одной штуки, прогноз не определён.
        {rows.length >= 200 && ' Показаны 200 самых срочных позиций.'}
      </p>
    </div>
  );
}
