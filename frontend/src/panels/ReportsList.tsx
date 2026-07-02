import { Link, useNavigate } from 'react-router-dom';
import { useCreateReport, useReports } from '@/api/queries';
import { useDemo } from '@/lib/demo-context';
import { fmt } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';
import { DEFAULT_REPORT_BLOCKS, ReportsErrorState } from '@/panels/ReportPage';

const SCHEDULE_LABELS: Record<string, string> = {
  none: 'Выкл',
  weekly: 'Раз в неделю',
  monthly: 'Раз в месяц',
};

/**
 * /reports — the saved-reports index (steep Reports, our warm-paper language): a hairline
 * TABLE of documents (Название / Выгрузка / Обновлён), row click opens the report, and a
 * pill CTA that creates a report with the full default block set and navigates into it.
 */
export function ReportsList() {
  const { demo } = useDemo();
  const reportsQuery = useReports(!demo); // demo has no reports fixture — skip the fetch
  const createReport = useCreateReport();
  const navigate = useNavigate();

  const handleCreate = () =>
    createReport.mutate(
      { name: 'Новый отчёт', config: { blocks: [...DEFAULT_REPORT_BLOCKS] } },
      { onSuccess: (data) => navigate(`/reports/${data.report.id}`) },
    );

  const reports = reportsQuery.data?.reports ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-medium tracking-tight">Отчёты</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Сохранённые документы: блоки настраиваются, выгрузка приходит письмом
          </p>
        </div>
        {!demo && (
          <button
            type="button"
            onClick={handleCreate}
            disabled={createReport.isPending}
            className="btn-pill bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {createReport.isPending ? 'Создание…' : 'Создать отчёт'}
          </button>
        )}
      </div>

      {createReport.isError && (
        <p className="text-xs text-ember">
          Не удалось создать отчёт: {createReport.error instanceof Error ? createReport.error.message : 'ошибка'}
        </p>
      )}

      {demo ? (
        <ReportsErrorState demo />
      ) : reportsQuery.isPending ? (
        <ReportsListSkeleton />
      ) : reportsQuery.isError ? (
        <ReportsErrorState error={reportsQuery.error} />
      ) : reports.length === 0 ? (
        <div className="rounded border border-dashed border-border bg-background px-4 py-10 text-center">
          <p className="text-sm font-medium text-foreground">Отчётов пока нет</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Соберите документ из блоков аналитики — его можно распечатать в PDF и получать письмом
            раз в неделю или месяц.
          </p>
          <button
            type="button"
            onClick={handleCreate}
            disabled={createReport.isPending}
            className="btn-pill mt-4 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {createReport.isPending ? 'Создание…' : 'Создать отчёт'}
          </button>
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="py-2 pr-3 text-left text-2xs font-medium tracking-wide text-muted-foreground">Название</th>
              <th className="py-2 pr-3 text-left text-2xs font-medium tracking-wide text-muted-foreground">Выгрузка</th>
              <th className="py-2 text-right text-2xs font-medium tracking-wide text-muted-foreground">Обновлён</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((report) => (
              <tr
                key={report.id}
                onClick={() => navigate(`/reports/${report.id}`)}
                className="cursor-pointer border-t border-border transition-colors hover:bg-hover-row/60"
              >
                {/* The name is a real link (keyboard/focus access); the row onClick keeps the
                    rest of the row clickable — same destination, so no stopPropagation needed. */}
                <td className="py-2.5 pr-3">
                  <Link to={`/reports/${report.id}`} className="font-medium text-foreground hover:underline">
                    {report.name}
                  </Link>
                </td>
                <td className="py-2.5 pr-3 text-muted-foreground">
                  {SCHEDULE_LABELS[report.schedule] ?? report.schedule}
                </td>
                {/* Timestamp — mono per the token governance (technical readout, not body copy). */}
                <td className="py-2.5 text-right font-mono text-xs text-muted-foreground">
                  {fmt.date(report.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Table-shaped loading scaffold (header strip + hairline rows — no card flash). */
function ReportsListSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between py-2">
        <Skeleton className="h-2.5 w-20" />
        <Skeleton className="h-2.5 w-16" />
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between border-t border-border py-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}
