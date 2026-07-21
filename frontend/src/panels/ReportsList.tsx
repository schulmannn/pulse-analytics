import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useChannels, useCreateReport, useReports } from '@/api/queries';
import type { ReportListItem } from '@/api/schemas';
import { useDemo } from '@/lib/demo-context';
import { fmt } from '@/lib/format';
import { useMediaQuery } from '@/lib/useMediaQuery';
import {
  filterReports,
  reportBlockCountLabel,
  reportDeliveryLabel,
  reportPeriodLabel,
  type ReportListFilter,
} from '@/lib/reportListModel';
import { TableSkeleton } from '@/components/ui/dataSkeleton';
import { EmptyState } from '@/components/EmptyState';
import { SearchField } from '@/components/SearchField';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Button } from '@/components/ui/button';
import { CreateReportDialog } from '@/components/reports/CreateReportDialog';
import { ReportsErrorState } from '@/panels/ReportPage';
import { DEFAULT_REPORT_BLOCKS, type ReportBlockKey } from '@/lib/reportBlocks';

const SCHEDULE_LABELS: Record<string, string> = {
  none: 'Выкл',
  weekly: 'Раз в неделю',
  monthly: 'Раз в месяц',
};

const REPORT_TEMPLATES: Array<{
  name: string;
  description: string;
  blocks: ReportBlockKey[];
}> = [
  {
    name: 'Еженедельный обзор',
    description: 'Изменения, ключевые метрики и лучшие публикации.',
    blocks: ['week', 'kpi-summary', 'metric-views', 'top-posts'],
  },
  {
    name: 'Рост аудитории',
    description: 'Подписчики, недельная динамика и наблюдения.',
    blocks: ['kpi-summary', 'metric-subscribers', 'weekly-table', 'insights'],
  },
  {
    name: 'Эффективность контента',
    description: 'Охват, реакции и публикации, которые дали результат.',
    blocks: ['kpi-summary', 'metric-views', 'metric-reactions', 'top-posts', 'insights'],
  },
];

/**
 * /reports — the saved-reports index. Desktop (md+) gets the redesigned working surface: a
 * compact header with one create command, a create DIALOG (name / template / Telegram source /
 * period / delivery), and a dense summary table. Mobile keeps its verbatim template-showcase
 * surface. JS branch (not CSS): only one mounts, so create flows never double-register.
 */
export function ReportsList() {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  return isDesktop ? <ReportsListDesktop /> : <ReportsListMobile />;
}

// ── Desktop: header + create dialog + dense summary table ───────────────────────────────────
function ReportsListDesktop() {
  const { demo } = useDemo();
  const reportsQuery = useReports(!demo);
  const { data: channelsData } = useChannels();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ReportListFilter>('all');

  const reports = reportsQuery.data?.reports ?? [];
  const channelName = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of channelsData?.channels ?? []) {
      map.set(c.id, c.username ? `@${c.username}` : c.title || `Источник #${c.id}`);
    }
    return (id: number | null | undefined) => (id != null ? map.get(id) ?? `Источник #${id}` : null);
  }, [channelsData]);

  const sourceLabelOf = (item: ReportListItem) => channelName(item.channel_id) ?? '';
  const visible = filterReports(reports, { query, filter, sourceLabelOf });

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      {/* Заголовок страницы живёт в шапке приложения — тело открывает вводный абзац. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Сохранённые отчёты по вашим источникам: собираются из блоков, по расписанию приходят на почту.
        </p>
        {!demo && (
          <Button type="button" onClick={() => setDialogOpen(true)}>
            Создать отчёт
          </Button>
        )}
      </div>

      {demo ? (
        <ReportsErrorState demo />
      ) : reportsQuery.isPending ? (
        <ReportsListSkeleton />
      ) : reportsQuery.isError ? (
        <ReportsErrorState error={reportsQuery.error} />
      ) : reports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-background px-4 py-10 text-center">
          <p className="text-sm font-medium text-foreground">Отчётов пока нет</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Соберите документ из блоков аналитики — его можно распечатать в PDF и получать письмом
            раз в неделю или месяц.
          </p>
          <Button type="button" onClick={() => setDialogOpen(true)} className="mt-4">
            Создать отчёт
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <SearchField
              className="w-64 max-w-full"
              value={query}
              onChange={setQuery}
              placeholder="Название или источник"
              ariaLabel="Поиск отчётов"
            />
            <SegmentedControl<ReportListFilter>
              ariaLabel="Фильтр отчётов"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', content: 'Все' },
                { value: 'delivery', content: 'С доставкой' },
              ]}
            />
          </div>

          {visible.length === 0 ? (
            <EmptyState compact size="table" title="Ничего не найдено." />
          ) : (
            <div className="data-table-surface data-table-scroll">
            <table className="data-table min-w-[760px] text-sm">
              <thead>
                <tr>
                  <Th className="text-left">Название</Th>
                  <Th className="text-left">Источник</Th>
                  <Th className="text-left">Период</Th>
                  <Th className="text-left">Блоки</Th>
                  <Th className="text-left">Доставка</Th>
                  <Th className="text-right">Обновлён</Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((report) => {
                  const src = channelName(report.channel_id);
                  return (
                    <tr
                      key={report.id}
                      onClick={() => navigate(`/reports/${report.id}`)}
                      className="cursor-pointer border-t border-border transition-colors hover:bg-hover-row/60"
                    >
                      {/* Name is a real link (keyboard/focus); the row shares the same destination. */}
                      <td className="py-2.5 pr-3">
                        <Link to={`/reports/${report.id}`} className="font-medium text-foreground hover:underline">
                          {report.name}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground">
                        {src ?? 'Текущий источник'}
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{reportPeriodLabel(report.period_days)}</td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{reportBlockCountLabel(report.block_count)}</td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{reportDeliveryLabel(report.schedule)}</td>
                      <td className="py-2.5 text-right font-mono text-xs text-muted-foreground">{fmt.date(report.updated_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </>
      )}

      {dialogOpen && <CreateReportDialog onClose={() => setDialogOpen(false)} />}
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={`py-2 pr-3 text-2xs font-medium tracking-wide text-muted-foreground ${className}`}>{children}</th>;
}

// ── Mobile: verbatim historical surface (template showcase + instant create + simple table) ──
function ReportsListMobile() {
  const { demo } = useDemo();
  const reportsQuery = useReports(!demo); // demo has no reports fixture — skip the fetch
  const createReport = useCreateReport();
  const navigate = useNavigate();

  const handleCreate = (template?: (typeof REPORT_TEMPLATES)[number]) =>
    createReport.mutate(
      {
        name: template?.name ?? `Отчёт от ${fmt.day(new Date())}`,
        config: { blocks: [...(template?.blocks ?? DEFAULT_REPORT_BLOCKS)] },
      },
      { onSuccess: (data) => navigate(`/reports/${data.report.id}`) },
    );

  const reports = reportsQuery.data?.reports ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-medium tracking-tight">Отчёты</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Сохранённые документы: блоки настраиваются, выгрузка приходит письмом
          </p>
        </div>
        {!demo && (
          <Button type="button" onClick={() => handleCreate()} disabled={createReport.isPending}>
            {createReport.isPending ? 'Создание…' : 'Создать отчёт'}
          </Button>
        )}
      </div>

      {createReport.isError && (
        <p className="text-xs text-ember">
          Не удалось создать отчёт: {createReport.error instanceof Error ? createReport.error.message : 'ошибка'}
        </p>
      )}

      {!demo && (
        <section aria-labelledby="report-templates-title" className="border-y border-border py-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 id="report-templates-title" className="text-sm font-medium text-foreground">Начать с шаблона</h3>
            <span className="text-2xs text-muted-foreground">Блоки можно изменить после создания</span>
          </div>
          <div className="grid gap-px overflow-hidden rounded border border-border bg-border md:grid-cols-3">
            {REPORT_TEMPLATES.map((template) => (
              <button
                key={template.name}
                type="button"
                onClick={() => handleCreate(template)}
                disabled={createReport.isPending}
                className="min-h-24 bg-background p-3 text-left transition-colors hover:bg-hover-row disabled:opacity-50"
              >
                <span className="block text-sm font-medium text-foreground">{template.name}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{template.description}</span>
                <span className="mt-3 block text-2xs text-primary">Создать →</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {demo ? (
        <ReportsErrorState demo />
      ) : reportsQuery.isPending ? (
        <ReportsListSkeleton />
      ) : reportsQuery.isError ? (
        <ReportsErrorState error={reportsQuery.error} />
      ) : reports.length === 0 ? (
        <EmptyState
          title="Отчётов пока нет"
          reason="Соберите документ из блоков аналитики — его можно распечатать в PDF и получать письмом раз в неделю или месяц. Выберите шаблон выше или создайте пустой отчёт."
        />
      ) : (
        <div className="data-table-surface data-table-scroll">
        <table className="data-table text-sm">
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
        </div>
      )}
    </div>
  );
}

/** Table-shaped loading scaffold (header strip + hairline rows — no card flash). */
function ReportsListSkeleton() {
  return <TableSkeleton rows={4} columns={4} />;
}
