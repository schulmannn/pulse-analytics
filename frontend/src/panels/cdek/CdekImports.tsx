import { useMemo, useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { TableSkeleton } from '@/components/ui/dataSkeleton';
import { LoaderDots } from '@/components/ui/loader';
import { Icon } from '@/components/nav-icons';
import { ApiError } from '@/api/client';
import { useCdekCoverage, useCdekImports, useCdekReplay, useCdekStatus, useCdekUpload, type CdekImport } from '@/api/cdek';
import { useSelectedChannel } from '@/lib/channel-context';
import { buildActivityCalendar, type ActivityCalendarDay } from '@/lib/activityCalendar';
import { fmt } from '@/lib/format';
import { formatMoney } from '@/lib/metricNumber';
import { cn } from '@/lib/utils';

/**
 * «Загрузки» СДЭКа — рабочая поверхность источника БЕЗ API.
 *
 * У источника, который наполняют руками, главный вопрос не «сколько выручки», а «что и за какой
 * период вообще залито». Отсюда состав: дропзона, отчёт последней загрузки и календарь покрытия,
 * где дыра в данных выглядит дырой, а не нулём.
 *
 * Журнальная логика взята из потока импорта Resend: файл принимается перетаскиванием, имя
 * подтверждается до результата, а итог разложен на принято / обновлено / отвергнуто с доступом к
 * отвергнутым строкам. Шага сопоставления колонок у нас нет намеренно — схема выгрузки СДЭКа
 * фиксированная, и мастер маппинга был бы обрядом без содержания.
 */

const ACCEPT = '.xlsx,.csv';
// Тот же потолок, что у роута (server/routes/cdek.js): годовая выгрузка ~110 КБ, запас
// двадцатикратный. Проверка здесь — вежливость (сказать до отправки), авторитет — на сервере.
const MAX_BYTES = 2 * 1024 * 1024;

const LEVEL_CLASS = [
  'bg-muted/40',
  'bg-primary/15',
  'bg-primary/30',
  'bg-primary/55',
  'bg-primary/85',
] as const;

const WEEKDAY_LABELS = ['Пн', '', 'Ср', '', 'Пт', '', ''];

/** Человеческий размер файла — в подписи дропзоны и в ошибке про потолок. */
function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** «2025-07-31 … 2026-07-30» — период, покрытый файлом. */
function periodLabel(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  return from === to ? fmt.day(from) : `${fmt.day(from)} — ${fmt.day(to)}`;
}

export function CdekImports() {
  const status = useCdekStatus();
  const imports = useCdekImports();
  const coverage = useCdekCoverage();
  const upload = useCdekUpload();
  const replay = useCdekReplay();
  const { channelId } = useSelectedChannel();
  const [error, setError] = useState<string | null>(null);
  // Отчёт ТОЛЬКО что загруженного файла живёт в state: список импортов обновится инвалидацией, но
  // подтверждение «вот что произошло с твоим файлом» должно появиться сразу и остаться на экране.
  const [fresh, setFresh] = useState<{ report: CdekImport | null; duplicate: boolean } | null>(null);

  const send = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError(`Файл больше ${fileSize(MAX_BYTES)} — столько выгрузка заказов не весит даже за несколько лет.`);
      return;
    }
    try {
      const res = await upload.mutateAsync(file);
      setFresh({ report: res.import, duplicate: res.duplicate });
      toast(res.duplicate ? 'Этот файл уже загружали' : 'Выгрузка загружена');
    } catch (err) {
      // 422 несёт человеческую причину («Это не .xlsx…») — показываем её, а не «что-то пошло не так».
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить выгрузку.');
    }
  };

  const lastImport = fresh?.report ?? status.data?.last_import ?? null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartWidget id="cdek-upload" title="Выгрузка из СДЭКа" fixedSize="full">
        <SourceMeta
          warehouse={status.data?.warehouse_code ?? null}
          tz={status.data?.tz ?? null}
          lastAt={status.data?.last_import?.created_at ?? null}
          pending={status.isPending}
        />
        <DropZone busy={upload.isPending} onFile={send} />
        {error && (
          <p role="alert" className="mt-3 text-xs text-ember">
            {error}
          </p>
        )}
        {fresh && <ImportReport report={fresh.report} duplicate={fresh.duplicate} channelId={channelId} />}
      </ChartWidget>

      <ChartWidget id="cdek-coverage" title="Покрытие данных" fixedSize="full">
        {coverage.isPending ? (
          <TableSkeleton rows={4} columns={6} />
        ) : coverage.isError ? (
          <ErrorState
            compact
            size="chart"
            title="Не удалось получить покрытие"
            onRetry={() => coverage.refetch()}
            retrying={coverage.isFetching}
          />
        ) : (
          <CoverageCalendar days={coverage.data?.days ?? []} />
        )}
      </ChartWidget>

      <ChartWidget id="cdek-history" title="История загрузок" fixedSize="full">
        {imports.isPending ? (
          <TableSkeleton rows={4} columns={5} />
        ) : imports.isError ? (
          <ErrorState
            compact
            size="table"
            title="Не удалось получить историю загрузок"
            onRetry={() => imports.refetch()}
            retrying={imports.isFetching}
          />
        ) : (
          <ImportHistory
            rows={imports.data?.imports ?? []}
            channelId={channelId}
            onReplay={(id) =>
              replay
                .mutateAsync(id)
                .then(() => toast('Импорт пересобран из сохранённого файла'))
                .catch((err) => toast(err instanceof ApiError ? err.message : 'Не удалось пересобрать импорт'))
            }
            replaying={replay.isPending ? (replay.variables ?? null) : null}
          />
        )}
      </ChartWidget>

      {lastImport?.warnings?.length ? <WarningsNote warnings={lastImport.warnings} /> : null}
    </div>
  );
}

/** Строка меты источника: склад, зона, когда заливали в прошлый раз. */
function SourceMeta({
  warehouse,
  tz,
  lastAt,
  pending,
}: {
  warehouse: string | null;
  tz: string | null;
  lastAt: string | null;
  pending: boolean;
}) {
  if (pending) return <div className="mb-3 h-4 w-56 animate-pulse rounded bg-muted/50" />;
  const parts = [
    warehouse ? `Склад ${warehouse}` : 'Склад определится по первой выгрузке',
    tz ? `время ${tz}` : null,
    lastAt ? `последняя загрузка ${fmt.date(lastAt)}` : 'загрузок ещё не было',
  ].filter(Boolean);
  return <p className="mb-3 text-xs text-muted-foreground">{parts.join(' · ')}</p>;
}

/**
 * Дропзона. Перетаскивание — основной жест (файл приходит из скачанных), клик — запасной.
 * Пунктир и акцентная подсветка на dragover: без отклика на наведение непонятно, куда именно
 * можно бросить.
 */
function DropZone({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const drop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file && !busy) onFile(file);
  };

  return (
    <>
      {/* Поле файла — СНАРУЖИ кнопки: интерактивный элемент внутри <button> невалиден. */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        aria-label="Файл выгрузки СДЭК"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Сбрасываем значение: иначе повторный выбор ТОГО ЖЕ файла не даёт события change,
          // и после исправленной выгрузки с тем же именем ничего не произойдёт.
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
      {/* Вся зона — НАСТОЯЩАЯ кнопка, а не div с ролью: клавиатура, фокус и семантика достаются
          даром, вложенной кнопки внутри нет (она ломала бы обход с клавиатуры). */}
      <button
        type="button"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn(
          'flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-8 text-center transition-colors',
          over ? 'border-primary bg-primary/5' : 'border-border',
          busy && 'cursor-default opacity-70',
        )}
        data-cdek-dropzone=""
      >
      {busy ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          Разбираем выгрузку <LoaderDots />
        </p>
      ) : (
        <>
          <Icon name="upload" className="mb-2 size-6 text-muted-foreground" />
          <p className="text-sm text-foreground">Перетащите файл выгрузки сюда</p>
          <p className="mt-1 text-sm font-medium text-primary">или выберите на диске</p>
          <p className="mt-2 text-2xs text-muted-foreground">
            .xlsx или .csv из личного кабинета СДЭКа, до {fileSize(MAX_BYTES)}. Повторная выгрузка с нахлёстом по датам —
            нормально: заказы обновятся, а не задвоятся.
          </p>
        </>
      )}
      </button>
    </>
  );
}

/** Итог загрузки: что принято, что обновлено, что отвергнуто — и за какой период. */
function ImportReport({
  report,
  duplicate,
  channelId,
}: {
  report: CdekImport | null;
  duplicate: boolean;
  channelId: number | null;
}) {
  if (!report) return null;
  const period = periodLabel(report.period_from, report.period_to);
  return (
    <div className="mt-4 rounded-lg border border-border p-4">
      <p className="text-sm font-medium text-foreground">
        {duplicate ? 'Этот файл уже загружали' : 'Выгрузка загружена'}
        <span className="ml-2 font-normal text-muted-foreground">{report.filename}</span>
      </p>
      {duplicate && (
        <p className="mt-1 text-xs text-muted-foreground">
          Содержимое совпадает с загрузкой от {report.created_at ? fmt.date(report.created_at) : 'прошлого раза'} — ничего
          не переписывали. Ниже её отчёт.
        </p>
      )}
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Fact label="строк" value={fmt.num(report.rows_total)} />
        <Fact label="заказов" value={fmt.num(report.orders_total)} />
        <Fact label="добавлено" value={fmt.num(report.rows_inserted)} />
        <Fact label="обновлено" value={fmt.num(report.rows_updated)} />
        <Fact
          label="отклонено"
          value={fmt.num(report.rows_rejected)}
          tone={report.rows_rejected > 0 ? 'warn' : undefined}
        />
      </dl>
      {period && <p className="mt-3 text-xs text-muted-foreground">Период файла: {period}</p>}
      {report.rows_rejected > 0 && (
        <p className="mt-2 text-xs">
          <a
            className="text-primary underline-offset-2 hover:underline"
            href={`/api/cdek/imports/${report.id}/rejected.csv${channelId != null ? `?channel=${channelId}` : ''}`}
          >
            Скачать отклонённые строки
          </a>{' '}
          <span className="text-muted-foreground">— их правят в Excel и загружают файл заново.</span>
        </p>
      )}
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div>
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', tone === 'warn' ? 'text-status-warn' : 'text-foreground')}>{value}</dd>
    </div>
  );
}

/** Предупреждения импорта — отдельной нотой: они не ошибка, но и не мелочь. */
function WarningsNote({ warnings }: { warnings: string[] }) {
  return (
    <div className="lg:col-span-6">
      <ul className="space-y-1 text-xs text-muted-foreground">
        {warnings.map((text) => (
          <li key={text}>· {text}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Календарь покрытия за год. Клетка несёт ДВА разных «пусто»: настоящий ноль заказов в залитый
 * день и отсутствие данных. Их различие — вся суть карточки: без него 61 день года без заказов
 * читается как провал продаж, хотя это дыра в загрузке.
 */
function CoverageCalendar({ days }: { days: Array<{ day: string; revenue: number | null; orders: number; covered: boolean }> }) {
  const model = useMemo(
    () =>
      buildActivityCalendar(
        days.map((d) => ({ day: d.day, views: d.revenue ?? 0, covered: d.covered })),
        new Date(),
        // День, которого нет в ответе, — не ноль, а «не залито».
        { defaultCovered: false },
      ),
    [days],
  );
  const covered = days.filter((d) => d.covered).length;

  if (!days.length) {
    return <EmptyState compact size="chart" title="Загрузите первую выгрузку — и здесь появится карта покрытия." />;
  }

  return (
    <div>
      <div className="overflow-x-auto pb-2">
        <div className="flex w-max gap-[3px]">
          <div className="mr-1 grid grid-rows-7 gap-[3px] text-2xs text-muted-foreground">
            {WEEKDAY_LABELS.map((label, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} className="flex h-3 items-center">
                {label}
              </div>
            ))}
          </div>
          {model.weeks.map((week) => (
            <div key={week.key} className="grid grid-rows-7 gap-[3px]">
              {week.days.map((day, i) => (
                <CoverageCell key={day ? day.day : `pad-${week.key}-${i}`} day={day} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="gap-hatch size-3 rounded-[2px] border border-border" /> выгрузки нет
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-[2px] bg-muted/40" /> 0 заказов
        </span>
        <span className="flex items-center gap-1">
          {LEVEL_CLASS.slice(1).map((cls) => (
            <span key={cls} className={cn('size-3 rounded-[2px]', cls)} />
          ))}
          больше выручка
        </span>
        <span>залито дней: {fmt.num(covered)}</span>
      </div>
    </div>
  );
}

function CoverageCell({ day }: { day: ActivityCalendarDay | null }) {
  if (!day) return <div className="size-3" />;
  const title = day.covered
    ? `${fmt.day(day.day)}: ${day.value > 0 ? `${formatMoney(day.value, 'exact')}` : 'заказов нет'}`
    : `${fmt.day(day.day)}: выгрузка не загружена`;
  return (
    <div
      title={title}
      className={cn(
        'size-3 rounded-[2px]',
        day.covered ? LEVEL_CLASS[day.level] : 'gap-hatch',
        day.isToday && 'ring-1 ring-primary/60',
      )}
    />
  );
}

/** История загрузок: что приезжало, когда и с каким результатом. */
function ImportHistory({
  rows,
  channelId,
  onReplay,
  replaying,
}: {
  rows: CdekImport[];
  channelId: number | null;
  onReplay: (id: number) => void;
  replaying: number | null;
}) {
  if (!rows.length) {
    return (
      <EmptyState
        compact
        size="table"
        title="Выгрузок пока нет"
        reason="В личном кабинете СДЭКа выгрузите заказы за нужный период и перетащите файл выше."
      />
    );
  }
  return (
    <div className="data-table-scroll">
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            <th scope="col" className="text-left">Файл</th>
            <th scope="col" className="text-left">Когда</th>
            <th scope="col" className="text-left">Период</th>
            <th scope="col" className="text-right">Строк</th>
            <th scope="col" className="text-right">Добавлено</th>
            <th scope="col" className="text-right">Обновлено</th>
            <th scope="col" className="text-right">Отклонено</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="max-w-[18rem] truncate" title={row.filename}>
                {row.filename}
                {row.status === 'error' && (
                  <span className="ml-2 text-2xs text-ember">{row.error || 'не разобрался'}</span>
                )}
              </td>
              <td className="whitespace-nowrap text-muted-foreground">{row.created_at ? fmt.date(row.created_at) : '—'}</td>
              <td className="whitespace-nowrap text-muted-foreground">
                {periodLabel(row.period_from, row.period_to) ?? '—'}
              </td>
              <td className="text-right tabular-nums">{fmt.num(row.rows_total)}</td>
              <td className="text-right tabular-nums">{fmt.num(row.rows_inserted)}</td>
              <td className="text-right tabular-nums">{fmt.num(row.rows_updated)}</td>
              <td className={cn('text-right tabular-nums', row.rows_rejected > 0 && 'text-status-warn')}>
                {fmt.num(row.rows_rejected)}
              </td>
              <td className="whitespace-nowrap text-right">
                {row.rows_rejected > 0 && (
                  <a
                    className="text-primary underline-offset-2 hover:underline"
                    href={`/api/cdek/imports/${row.id}/rejected.csv${channelId != null ? `?channel=${channelId}` : ''}`}
                  >
                    отклонённые
                  </a>
                )}
                {row.status === 'done' && (
                  <button
                    type="button"
                    onClick={() => onReplay(row.id)}
                    disabled={replaying === row.id}
                    className="ml-3 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                    // Переигровка нужна, когда уточнились правила разбора: архив пересобирается из
                    // сохранённого файла, а не просится у пользователя заново.
                    title="Пересобрать архив из сохранённого файла"
                  >
                    {replaying === row.id ? 'пересобираем…' : 'пересобрать'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
