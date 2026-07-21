import { useEffect, useMemo, useRef, useState } from 'react';
import { useConfirm } from '@/components/ConfirmDialogProvider';
import { cn } from '@/lib/utils';
import { Pencil, Printer, Save, X } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useDeleteReport, useUpdateReport } from '@/api/queries';
import type { Report } from '@/api/schemas';
import { ErrorState } from '@/components/ErrorState';
import { PillSelect } from '@/components/PillSelect';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/lib/format';
import type { PeriodDays } from '@/lib/period';
import { buildDraft, draftToPutBody, isDraftDirty } from '@/lib/reportDraft';
import type { ReportDraft, ReportSchedule } from '@/lib/reportDraft';
import { reportPeriodLabel } from '@/lib/reportListModel';
import { defaultBlock } from '@/lib/reportBlocks';
import type { ReportBlockKey, ReportBlockType } from '@/lib/reportBlocks';
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
  const confirm = useConfirm();
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
  const handleDelete = async () => {
    const ok = await confirm({
      title: `Удалить отчёт «${report.name}»?`,
      reason: 'Документ и его настройки будут удалены.',
    });
    if (!ok) return;
    deleteReport.mutate(report.id, { onSuccess: () => navigate('/reports', { replace: true }) });
  };

  const periodText = data.rangeLabel ?? reportPeriodLabel(editing ? draft.periodDays : baseline.periodDays);
  const channelLabel = data.channelLabel;

  return (
    <div className="report-rhea mx-auto w-full max-w-6xl">
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
            className="report-title-input w-full border-b border-primary/40 bg-transparent pb-1 text-3xl font-medium tracking-tight text-foreground focus:border-primary focus:outline-hidden"
          />

          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div className="report-field text-xs font-medium text-muted-foreground">
              <span className="report-field__label mb-1 block">Период</span>
              <SegmentedControl
                ariaLabel="Период отчёта"
                value={String(draft.periodDays)}
                onChange={(days) => pickPeriod(Number(days) as PeriodDays)}
                options={PERIOD_CHIPS.map((chip) => ({ value: String(chip.days), content: chip.label }))}
              />
            </div>

            <div className="report-field text-xs font-medium text-muted-foreground">
              <span className="report-field__label mb-1 block">Источник · Telegram</span>
              <PillSelect
                value={draft.source != null ? String(draft.source) : ''}
                onValueChange={(v) => pickSource(v ? Number(v) : null)}
                ariaLabel="Источник · Telegram"
                className="report-select min-w-52"
                contentClassName="report-select-content"
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

            <div className="report-field text-xs font-medium text-muted-foreground">
              <span className="report-field__label mb-1 block">Доставка на почту</span>
              <PillSelect<ReportSchedule>
                value={draft.schedule}
                onValueChange={(v) => setDraft((x) => ({ ...x, schedule: v }))}
                ariaLabel="Доставка на почту"
                className="report-select"
                contentClassName="report-select-content"
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
            <Button
              type="button"
              onClick={cancelEdit}
              variant="ghost"
              size="sm"
              className="report-control text-muted-foreground"
            >
              <X aria-hidden="true" />
              Отмена
            </Button>
            <Button
              type="button"
              onClick={save}
              disabled={savePending || !nameValid || !sourceValid || !dirty}
              size="sm"
              className="report-control bg-foreground text-background shadow-xs hover:bg-foreground/80"
            >
              <Save aria-hidden="true" />
              {savePending ? 'Сохранение…' : 'Сохранить'}
            </Button>
            <span className="flex-1" />
            <Button
              type="button"
              onClick={handleDelete}
              disabled={deleteReport.isPending}
              variant="ghost"
              size="sm"
              className="report-control text-muted-foreground hover:text-destructive"
            >
              {deleteReport.isPending ? 'Удаление…' : 'Удалить отчёт'}
            </Button>
          </div>
        </div>
      ) : (
        // ── Read mode: a working document header, no editor chrome ──
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="report-title text-3xl font-medium tracking-tight text-foreground">{report.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Telegram · {channelLabel} · {periodText} · обновлён {fmt.date(report.updated_at)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 print:hidden">
            <Button
              type="button"
              onClick={enterEdit}
              size="sm"
              className="report-control bg-foreground text-background shadow-xs hover:bg-foreground/80"
            >
              <Pencil aria-hidden="true" />
              Редактировать
            </Button>
            <Button
              type="button"
              onClick={() => window.print()}
              variant="outline"
              size="sm"
              className="report-control border-foreground/10 bg-card text-foreground shadow-xs"
            >
              <Printer aria-hidden="true" />
              Печать / PDF
            </Button>
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
          <>
            <ReportOutline blocks={blocks} editing={editing} />
            <ReportComposition
              blocks={blocks}
              data={data}
              editable={editing}
              onInsert={insertBlock}
              onMove={moveBlock}
              onRemove={removeBlock}
              onSetConfig={setBlockConfig}
            />
          </>
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


/**
 * Оглавление длинного документа (Astryx Outline): фикс-рейл справа ТОЛЬКО на 2xl+ — макет
 * max-w-6xl на обычном десктопе не двигается ни на пиксель. Заголовки собираются из DOM
 * (.report-section h3) — устойчиво к любым будущим блокам; scroll-spy на IntersectionObserver;
 * скрыт в редактировании и в print (PDF-канон документа без чужого хрома).
 */
function ReportOutline({ blocks, editing }: { blocks: ReadonlyArray<unknown>; editing: boolean }) {
  const [items, setItems] = useState<Array<{ id: string; title: string }>>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (editing) {
      setItems([]);
      return;
    }
    // После рендера состава: разделы получают стабильные id по порядку, заголовок — из их h3.
    const frame = requestAnimationFrame(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>('.report-section')];
      setItems(
        nodes.map((node, index) => {
          if (!node.id) node.id = `report-sec-${index}`;
          return { id: node.id, title: node.querySelector('h3')?.textContent?.trim() || `Раздел ${index + 1}` };
        }),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [blocks, editing]);

  useEffect(() => {
    if (items.length === 0) return;
    // Детерминированный spy по позициям (IO у дна документа неоднозначен: предыдущая высокая
    // секция продолжает пересекать «активную полосу»): активна ПОСЛЕДНЯЯ секция, чей верх выше
    // трети вьюпорта; ниже первой секции — первая.
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = window.innerHeight * 0.3;
      let current = items[0]?.id ?? null;
      for (const item of items) {
        const el = document.getElementById(item.id);
        if (el && el.getBoundingClientRect().top <= line) current = item.id;
      }
      // Дно документа: последняя секция может физически не долистываться до активной линии —
      // прокрутка упёрлась в конец значит читается именно она.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        current = items[items.length - 1]?.id ?? current;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [items]);

  // Короткому документу оглавление не нужно — не рисуем хром ради хрома.
  if (editing || items.length < 3) return null;
  return (
    <nav
      aria-label="Оглавление отчёта"
      data-testid="report-outline"
      className="fixed right-6 top-28 z-sticky hidden w-44 2xl:block print:hidden"
    >
      <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Оглавление</p>
      <ul className="mt-2 space-y-0.5 border-l border-border">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              aria-current={active === item.id ? 'true' : undefined}
              className={cn(
                '-ml-px block w-full truncate border-l-2 py-0.5 pl-3 text-left text-2xs transition-colors',
                active === item.id
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
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
