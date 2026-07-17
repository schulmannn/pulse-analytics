import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDeleteReport, useUpdateReport } from '@/api/queries';
import type { Report } from '@/api/schemas';
import { ErrorState } from '@/components/ErrorState';
import { PillSelect } from '@/components/PillSelect';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/lib/format';
import type { PeriodDays } from '@/lib/period';
import { buildDraft, draftToPutBody, isDraftDirty } from '@/lib/reportDraft';
import type { ReportDraft, ReportSchedule } from '@/lib/reportDraft';
import { reportPeriodLabel } from '@/lib/reportListModel';
import { defaultBlock } from '@/lib/reportBlocks';
import type { ReportBlockKey, ReportBlockType } from '@/lib/reportBlocks';
import { cn } from '@/lib/utils';
import { PERIOD_CHIPS } from '@/panels/report/blocks';
import { ReportComposition } from '@/panels/report/ReportComposition';
import { useReportData } from '@/panels/report/useReportData';

/**
 * Desktop report document (md+). Reads by default: a clean, wide (max-w-6xl) artifact with a
 * working-document header (breadcrumb, title, one metadata line, «Редактировать» / «Печать / PDF»)
 * — no inline «+», no per-block toolbars, no textareas. «Редактировать» opens an explicit edit
 * mode over a LOCAL draft (name / period / source / delivery / blocks); «Сохранить» commits it as
 * ONE PUT (no debounce race) and returns to read mode on the server echo; «Отмена» discards back
 * to the last saved state. Source selection stays inside the report's ChannelScope (via
 * onPickSource) and never mutates the global switcher. Mobile keeps its own always-inline surface.
 */
export function ReportDocumentDesktop({
  report,
  onPickSource,
}: {
  report: Report;
  /** ChannelScope is owned by the parent; draft source changes flow back through this callback. */
  onPickSource: (id: number | null) => void;
}) {
  const data = useReportData();
  const navigate = useNavigate();
  const updateReport = useUpdateReport(report.id);
  const deleteReport = useDeleteReport();

  const baseline = useMemo(() => buildDraft(report), [report]);
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [draft, setDraft] = useState<ReportDraft>(baseline);
  const telegramChannels = data.channels.filter((channel) => channel.source !== 'ig');

  // Restore the report's persisted period once on open (read mode shows the document's own period),
  // unless the viewer already has an explicit window (custom range / shared ?p= / ?from). Mirrors
  // the mobile surface so both open on the same period.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (data.range !== null) return;
    const search = typeof window !== 'undefined' ? window.location.search : '';
    if (search.includes('p=') || search.includes('from=')) return;
    data.setDays(baseline.periodDays);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot restore, guarded by the ref
  }, []);

  if (data.status === 'pending') return <DesktopSkeleton />;

  const editing = mode === 'edit';
  const blocks = editing ? draft.blocks : baseline.blocks;
  const dirty = isDraftDirty(draft, baseline);
  const savePending = updateReport.isPending;
  const nameValid = draft.name.trim().length > 0 && draft.name.trim().length <= 120;
  const sourceValid = draft.source != null && telegramChannels.some((channel) => channel.id === draft.source);

  const enterEdit = () => {
    const currentIsTelegram = data.channelId != null && telegramChannels.some((channel) => channel.id === data.channelId);
    const savedIsTelegram = baseline.source != null && telegramChannels.some((channel) => channel.id === baseline.source);
    const editSource = savedIsTelegram
      ? baseline.source
      : currentIsTelegram
        ? data.channelId
        : telegramChannels[0]?.id ?? null;
    setDraft({ ...baseline, source: editSource });
    data.setDays(baseline.periodDays);
    onPickSource(editSource);
    updateReport.reset();
    setMode('edit');
  };
  // Cancel fully reverts name/period/source/schedule/blocks to the last saved state — never a
  // silent save of the discarded edits.
  const cancelEdit = () => {
    data.setDays(baseline.periodDays);
    onPickSource(baseline.source);
    setDraft(baseline);
    setMode('read');
  };
  const pickPeriod = (d: PeriodDays) => {
    setDraft((x) => ({ ...x, periodDays: d }));
    data.setDays(d);
  };
  const pickSource = (id: number | null) => {
    setDraft((x) => ({ ...x, source: id }));
    onPickSource(id);
  };
  const insertBlock = (at: number, type: ReportBlockType, key?: ReportBlockKey) =>
    setDraft((x) => ({ ...x, blocks: [...x.blocks.slice(0, at), defaultBlock(type, key), ...x.blocks.slice(at)] }));
  const moveBlock = (idx: number, dir: -1 | 1) =>
    setDraft((x) => {
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= x.blocks.length) return x;
      const next = [...x.blocks];
      [next[idx], next[j]] = [next[j], next[idx]];
      return { ...x, blocks: next };
    });
  const removeBlock = (idx: number) => setDraft((x) => ({ ...x, blocks: x.blocks.filter((_, i) => i !== idx) }));
  const setBlockConfig = (idx: number, patch: Record<string, unknown>) =>
    setDraft((x) => ({ ...x, blocks: x.blocks.map((b, i) => (i === idx ? { ...b, config: { ...b.config, ...patch } } : b)) }));

  const save = () => {
    if (savePending || !nameValid || !sourceValid) return;
    updateReport.mutate(draftToPutBody(draft, report.config), { onSuccess: () => setMode('read') });
  };
  const handleDelete = () => {
    if (!window.confirm(`Удалить отчёт «${report.name}»?`)) return;
    deleteReport.mutate(report.id, { onSuccess: () => navigate('/reports', { replace: true }) });
  };

  const periodText = data.rangeLabel ?? reportPeriodLabel(editing ? draft.periodDays : baseline.periodDays);
  const channelLabel = data.channelLabel;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <Link
        to="/reports"
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground print:hidden"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M10 3 5 8l5 5" />
        </svg>
        Отчёты
      </Link>

      {editing ? (
        // ── Edit mode: explicit draft controls, single Save / Cancel ──
        <div className="mt-2 space-y-4">
          <input
            value={draft.name}
            onChange={(e) => setDraft((x) => ({ ...x, name: e.target.value }))}
            maxLength={120}
            aria-label="Название отчёта"
            placeholder="Название отчёта"
            className="w-full border-b border-primary/40 bg-transparent pb-1 text-3xl font-medium tracking-tight text-foreground focus:border-primary focus:outline-none"
          />

          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <label className="text-xs font-medium text-muted-foreground">
              <span className="mb-1 block">Период</span>
              <div className="flex overflow-hidden rounded-full border border-border">
                {PERIOD_CHIPS.map((chip) => (
                  <button
                    key={chip.days}
                    type="button"
                    aria-pressed={draft.periodDays === chip.days}
                    onClick={() => pickPeriod(chip.days)}
                    className={cn(
                      'border-r border-border px-3 py-1.5 text-xs font-medium transition-colors last:border-r-0',
                      draft.periodDays === chip.days ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50',
                    )}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </label>

            <div className="text-xs font-medium text-muted-foreground">
              <span className="mb-1 block">Источник · Telegram</span>
              <PillSelect
                value={draft.source != null ? String(draft.source) : ''}
                onValueChange={(v) => pickSource(v ? Number(v) : null)}
                ariaLabel="Источник · Telegram"
                className="min-w-52"
                options={[
                  { value: '', label: 'Выберите источник', disabled: true },
                  ...(draft.source != null && !sourceValid
                    ? [{ value: String(draft.source), label: `Недоступный Telegram-источник #${draft.source}`, disabled: true }]
                    : []),
                  ...telegramChannels.map((c) => ({
                    value: String(c.id),
                    label: c.username ? `@${c.username}` : c.title || `Источник #${c.id}`,
                  })),
                ]}
              />
            </div>

            <div className="text-xs font-medium text-muted-foreground">
              <span className="mb-1 block">Доставка на почту</span>
              <PillSelect<ReportSchedule>
                value={draft.schedule}
                onValueChange={(v) => setDraft((x) => ({ ...x, schedule: v }))}
                ariaLabel="Доставка на почту"
                options={[
                  { value: 'none', label: 'Выкл' },
                  { value: 'weekly', label: 'Раз в неделю' },
                  { value: 'monthly', label: 'Раз в месяц' },
                ]}
              />
            </div>
          </div>

          {draft.schedule !== 'none' && (
            <p className="text-2xs text-muted-foreground">
              На почту придёт письмо со ссылкой на этот отчёт{draft.schedule === 'weekly' ? ' каждую неделю' : ' каждый месяц'} —
              документ пересчитывается при открытии.
            </p>
          )}

          {updateReport.isError && (
            <p role="alert" className="text-xs text-destructive">
              Не удалось сохранить: {updateReport.error instanceof Error ? updateReport.error.message : 'ошибка'}
            </p>
          )}

          <div className="flex items-center gap-2 border-y border-border py-3">
            <button
              type="button"
              onClick={cancelEdit}
              className="btn-pill px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={save}
              disabled={savePending || !nameValid || !sourceValid || !dirty}
              className="btn-pill bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {savePending ? 'Сохранение…' : 'Сохранить'}
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleteReport.isPending}
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
            >
              {deleteReport.isPending ? 'Удаление…' : 'Удалить отчёт'}
            </button>
          </div>
        </div>
      ) : (
        // ── Read mode: a working document header, no editor chrome ──
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-3xl font-medium tracking-tight text-foreground">{report.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Telegram · {channelLabel} · {periodText} · обновлён {fmt.date(report.updated_at)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 print:hidden">
            <button
              type="button"
              onClick={enterEdit}
              className="btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Редактировать
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Печать / PDF
            </button>
          </div>
        </div>
      )}

      <div className="mt-8">
        {data.status === 'error' ? (
          <ErrorState
            title="Не удалось построить отчёт"
            reason={data.error instanceof Error ? data.error.message : 'ошибка'}
          />
        ) : (
          <ReportComposition
            blocks={blocks}
            data={data}
            editable={editing}
            onInsert={insertBlock}
            onMove={moveBlock}
            onRemove={removeBlock}
            onSetConfig={setBlockConfig}
          />
        )}
      </div>

      <div className="mt-10 border-t border-border pt-3">
        <p className="text-2xs text-muted-foreground">
          Atlavue · Telegram (MTProto) + дневной архив сборщика. Документ пересчитывается при открытии.
        </p>
      </div>
    </div>
  );
}

function DesktopSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-10">
      <div>
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-3 h-8 w-72" />
        <Skeleton className="mt-2 h-3 w-64" />
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-background p-3">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="mt-2 h-5 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="h-52 w-full" />
    </div>
  );
}
