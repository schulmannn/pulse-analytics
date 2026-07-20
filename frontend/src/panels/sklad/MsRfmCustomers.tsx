import { useEffect, useState } from 'react';
import { fetchMsRfmCustomersPage, useMsRfmSegmentCustomers, type MsRfmCustomers } from '@/api/queries';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { toYmd } from '@/lib/analyticsExport';
import { useSelectedChannel } from '@/lib/channel-context';
import { downloadCsv, type CsvRow } from '@/lib/csv';
import { fmt, pluralRu } from '@/lib/format';
import { msPeriodKey, type MsPeriod } from '@/lib/msPeriod';

type Row = MsRfmCustomers['rows'][number];

/** Размер страницы CSV-выгрузки — крупнее интерактивных 50: большой сегмент собирается за
    считанные запросы, а не десятки «Показать ещё»-страниц. */
export const MS_RFM_EXPORT_PAGE = 200;

/** Имя файла выгрузки: rfm-<segment>-<YYYY-MM-DD>.csv (локальный день скачивания). */
export function rfmExportFilename(segment: string, nowMs: number = Date.now()): string {
  return `rfm-${segment}-${toYmd(nowMs)}.csv`;
}

/** Чистая проекция строк сегмента в CSV-колонки (русские заголовки — файл читает владелец).
    null-поля словаря контрагентов (имя/адрес/город) — честные пустые ячейки; эскейп кавычек,
    разделителей и BOM — канон lib/csv. */
export function rfmCustomersCsvRows(rows: Row[]): CsvRow[] {
  return rows.map((row) => ({
    Покупатель: row.name,
    Адрес: row.address,
    Город: row.city,
    Заказов: row.orders,
    'Сумма ₽': row.sum,
    'Последний заказ': row.last_day,
    'Дней с заказа': row.recency_days,
    R: row.r,
    F: row.f,
    M: row.m,
  }));
}

/** Offset-цикл по ВСЕМ страницам сегмента до total_customers. `fetchPage` инжектируется — юнит-тест
    гоняет цикл без сети. Пустая страница до total тоже останавливает цикл: если срез на сервере
    успел уменьшиться, выгрузка честно завершается, а не зацикливается. */
export async function collectRfmSegmentRows(
  fetchPage: (offset: number) => Promise<Pick<MsRfmCustomers, 'rows' | 'total_customers'>>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (;;) {
    const page = await fetchPage(rows.length);
    rows.push(...page.rows);
    if (rows.length >= page.total_customers || page.rows.length === 0) return rows;
  }
}

/** Накопленные страницы листинга: `key` пришпиливает их к паре сегмент+окно, чтобы смена любого
    из них честно сбрасывала на первую страницу, а не подклеивала строки чужого среза. */
interface Acc {
  key: string;
  rows: Row[];
  total: number | null;
}

const EMPTY = (key: string): Acc => ({ key, rows: [], total: null });

const SKELETON_ROWS = ['rc1', 'rc2', 'rc3', 'rc4', 'rc5'];

/**
 * Покупатели выбранного RFM-сегмента — сознательный tenant-scoped листинг (в отличие от
 * агрегатного распределения MsRfmBody). Страницы по 50 строк копятся в состоянии («Показать ещё»),
 * смена сегмента или окна сбрасывает на первую страницу. R/F/M-оценки строк в UI не показываем —
 * перегруз; сегмент уже назван в заголовке карточки.
 */
export function MsRfmSegmentCustomers({ period, segment }: { period: MsPeriod; segment: string }) {
  const windowKey = [segment, ...msPeriodKey(period)].join('·');
  const { channelId } = useSelectedChannel();
  const [acc, setAcc] = useState<Acc>(() => EMPTY(windowKey));
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // Канонический React-сброс derived-состояния при смене пропсов: setState прямо в рендере
  // (React откатывает вывод и рендерит заново) — эффект опоздал бы на кадр и мигнул чужими строками.
  const stale = acc.key !== windowKey;
  if (stale) {
    setAcc(EMPTY(windowKey));
    setOffset(0);
    setExportError(null);
  }
  const effOffset = stale ? 0 : offset;
  const page = useMsRfmSegmentCustomers(period, segment, effOffset);

  useEffect(() => {
    const data = page.data;
    if (!data) return;
    // Подклеиваем только СЛЕДУЮЩУЮ страницу текущего среза (offset == уже показанным строкам):
    // фоновый рефетч ранней страницы или ответ прежнего сегмента не задваивают список.
    setAcc((prev) => (prev.key === windowKey && prev.rows.length === effOffset
      ? { key: prev.key, rows: [...prev.rows, ...data.rows], total: data.total_customers }
      : prev));
  }, [page.data, effOffset, windowKey]);

  const rows = stale ? [] : acc.rows;
  const total = stale ? null : acc.total;

  if (rows.length === 0 && page.isPending) {
    return (
      <div className="space-y-2 py-2">
        {SKELETON_ROWS.map((key) => (
          <Skeleton key={key} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (rows.length === 0 && page.isError) {
    return (
      <ErrorState
        className="py-4"
        title="Не удалось получить покупателей сегмента"
        reason={page.error instanceof Error ? page.error.message : 'ошибка'}
        onRetry={() => page.refetch()}
        retrying={page.isFetching}
      />
    );
  }
  if (total === 0) {
    return <p className="py-4 text-sm text-muted-foreground">Нет покупателей в сегменте за период.</p>;
  }

  const allNamesNull = rows.length > 0 && rows.every((row) => row.name == null);

  // Выгрузка тянет ВСЕ страницы сегмента заново (limit=200, мимо кэша листинга) — CSV всегда
  // полный срез, независимо от того, сколько «Показать ещё» уже нажато.
  const handleExport = async () => {
    if (exporting || channelId == null) return;
    setExporting(true);
    setExportError(null);
    try {
      const all = await collectRfmSegmentRows((exportOffset) =>
        fetchMsRfmCustomersPage(channelId, period, segment, MS_RFM_EXPORT_PAGE, exportOffset),
      );
      downloadCsv(rfmExportFilename(segment), rfmCustomersCsvRows(all));
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'ошибка');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      {total != null && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {fmt.num(total)} {pluralRu(total, ['покупатель', 'покупателя', 'покупателей'])}
          </p>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="btn-pill shrink-0 border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
          >
            {exporting ? 'Готовим…' : 'Выгрузить CSV'}
          </button>
        </div>
      )}
      {exportError != null && (
        <ErrorState
          className="mt-2 py-4"
          title="Не удалось выгрузить CSV"
          reason={exportError}
          onRetry={handleExport}
          retrying={exporting}
        />
      )}
      <ul className="mt-1">
        {rows.map((row, i) => (
          <li key={row.agent_id} className="border-t border-border py-2.5 first:border-t-0">
            <div className="flex items-center gap-3">
              <span className="w-5 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">{i + 1}</span>
              <span className={`min-w-0 flex-1 truncate text-sm ${row.name ? 'text-foreground' : 'text-muted-foreground'}`}>
                {row.name ?? 'Без имени'}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {fmt.num(row.orders)} {pluralRu(row.orders, ['заказ', 'заказа', 'заказов'])}
              </span>
              <span className="w-28 shrink-0 text-right text-sm font-medium tabular-nums">{fmt.short(row.sum)} ₽</span>
            </div>
            <p className="mt-0.5 flex min-w-0 items-baseline gap-1.5 pl-8 text-2xs text-muted-foreground">
              {row.city && <span className="shrink-0">{row.city}</span>}
              {row.city && row.address && <span aria-hidden="true">·</span>}
              {row.address && (
                <span className="min-w-0 truncate" title={row.address}>{row.address}</span>
              )}
              {(row.city || row.address) && <span aria-hidden="true">·</span>}
              <span className="shrink-0 whitespace-nowrap">последний заказ {fmt.day(row.last_day)}</span>
            </p>
          </li>
        ))}
      </ul>
      {page.isError && (
        <ErrorState
          className="mt-2 py-4"
          title="Не удалось получить следующую страницу"
          reason={page.error instanceof Error ? page.error.message : 'ошибка'}
          onRetry={() => page.refetch()}
          retrying={page.isFetching}
        />
      )}
      {!page.isError && total != null && rows.length < total && (
        <button
          type="button"
          onClick={() => setOffset(rows.length)}
          disabled={page.isFetching}
          className="btn-pill mt-3 border border-border px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        >
          {page.isFetching ? 'Загрузка…' : 'Показать ещё'}
        </button>
      )}
      {/* Деградацию словаря и честно-пустой ответ (все контрагенты страницы удалены из МС)
          контракт не различает — формулировка нейтральная, без вины «справочник недоступен». */}
      {allNamesNull && (
        <p className="mt-2 text-2xs text-muted-foreground">
          Имена и адреса контрагентов сейчас недоступны — показаны только данные заказов.
        </p>
      )}
    </div>
  );
}
