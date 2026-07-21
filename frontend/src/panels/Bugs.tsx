import { useState, type FormEvent } from 'react';
import { useBugs, useCreateBug, useUpdateBugStatus, useDeleteBug } from '@/api/queries';
import { PillSelect } from '@/components/PillSelect';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { useConfirm } from '@/components/ConfirmDialogProvider';
import { fmt } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';

const KIND_LABELS: Record<string, string> = { bug: 'Баг', feature: 'Фича', change: 'Правка' };
const SEVERITY_LABELS: Record<string, string> = { low: 'Низкая', medium: 'Средняя', high: 'Высокая' };
const STATUS_LABELS: Record<string, string> = { open: 'Открыт', in_progress: 'В работе', done: 'Готово', wont_fix: 'Не баг' };

export function Bugs() {
  const confirm = useConfirm();
  const { data, isLoading, isError, error } = useBugs();
  const createBugMutation = useCreateBug();
  const deleteBugMutation = useDeleteBug();

  const [textInput, setTextInput] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [kindInput, setKindInput] = useState('bug');
  const [severityInput, setSeverityInput] = useState('medium');

  if (isLoading) return <BugsSkeleton />;
  if (isError) {
    return <ErrorState title="Не удалось загрузить баг-трекер" reason={error instanceof Error ? error.message : 'ошибка сервера'} />;
  }

  if (data?.enabled === false) {
    return (
      <EmptyState title="БД не подключена" reason="Баг-трекер недоступен." />
    );
  }

  const bugs = data?.bugs ?? [];
  const availableStatuses = data?.statuses ?? ['open', 'in_progress', 'done', 'wont_fix'];

  const handleSubmitBug = async (e: FormEvent) => {
    e.preventDefault();
    const cleanText = textInput.trim();
    if (!cleanText) return;
    try {
      setSubmitError(null);
      await createBugMutation.mutateAsync({ text: cleanText, kind: kindInput, severity: severityInput, context: 'source=telegram' });
      setTextInput('');
      setKindInput('bug');
      setSeverityInput('medium');
    } catch {
      // Inline вместо browser-alert (аудит: нативный диалог вне темы и канона).
      setSubmitError('Не удалось отправить тикет — попробуйте ещё раз');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-medium tracking-tight">Баг-трекер</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Дефекты интерфейса, идеи и правки</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium tracking-tight text-muted-foreground">Сообщить о баге / предложить фичу</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmitBug} className="space-y-4">
            <textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Опишите проблему или предложение…"
              rows={3}
              disabled={createBugMutation.isPending}
              className="w-full resize-y rounded border bg-background p-2.5 text-sm leading-relaxed focus:outline-hidden focus:ring-1 focus:ring-primary disabled:opacity-50"
            />
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <PillSelect
                  value={kindInput}
                  options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
                  onValueChange={(v) => setKindInput(v)}
                  disabled={createBugMutation.isPending}
                  ariaLabel="Тип обращения"
                />
                <PillSelect
                  value={severityInput}
                  options={Object.entries(SEVERITY_LABELS).map(([value, label]) => ({ value, label }))}
                  onValueChange={(v) => setSeverityInput(v)}
                  disabled={createBugMutation.isPending}
                  ariaLabel="Важность"
                />
              </div>
              <button
                type="submit"
                disabled={createBugMutation.isPending || !textInput.trim()}
                className="rounded bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {createBugMutation.isPending ? 'Отправка…' : 'Создать тикет'}
              </button>
              {submitError && <p role="alert" className="text-xs text-destructive">{submitError}</p>}
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h3 className="px-1 text-xs font-medium tracking-wider text-muted-foreground">Тикеты</h3>
        {bugs.length === 0 ? (
          <EmptyState title="Багов пока нет" />
        ) : (
          <div className="space-y-3">
            {bugs.map((bug) => (
              <BugRowCard
                key={bug.id}
                bug={bug}
                availableStatuses={availableStatuses}
                onDelete={async (id) => {
                  const ok = await confirm({ title: 'Удалить запись из баг-трекера?' });
                  if (ok) deleteBugMutation.mutate(id);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface BugRowCardProps {
  bug: {
    id: number;
    created_at?: string | null;
    status?: string | null;
    severity?: string | null;
    kind?: string | null;
    text?: string | null;
    context?: string | null;
    occurrence_count?: number | null;
    last_seen?: string | null;
  };
  availableStatuses: string[];
  onDelete: (id: number) => void;
}

function BugRowCard({ bug, availableStatuses, onDelete }: BugRowCardProps) {
  const updateStatusMutation = useUpdateBugStatus(bug.id);
  const isCompleted = bug.status === 'done' || bug.status === 'wont_fix';

  const kindColors: Record<string, string> = {
    bug: 'text-ember bg-ember/10',
    feature: 'text-verdant bg-verdant/10',
    change: 'text-primary bg-primary/10',
    crash: 'text-ember bg-ember/10',
  };
  // 'crash' is auto-reported (POST /api/client-errors), not a create-form option, so its label lives
  // here rather than in KIND_LABELS (which drives the ticket form's kind selector).
  const kindLabel = KIND_LABELS[bug.kind ?? ''] || (bug.kind === 'crash' ? 'Крах' : bug.kind);
  const severityColors: Record<string, string> = { high: 'text-ember', low: 'text-verdant', medium: 'text-primary' };
  const currentKindClass = kindColors[bug.kind ?? ''] || 'text-muted-foreground bg-muted';
  const currentSeverityClass = severityColors[bug.severity ?? ''] || 'text-muted-foreground';
  // Aggregated crashes collapse to one ticket; show an honest repeat count (≥2) so an admin sees a
  // recurring crash isn't a one-off. Historical/pre-signature crashes have no count → nothing shown.
  const crashCount = bug.kind === 'crash' && typeof bug.occurrence_count === 'number' ? bug.occurrence_count : null;

  const handleStatusChange = (status: string) => updateStatusMutation.mutate({ status });

  return (
    <Card className={`transition-opacity ${isCompleted ? 'opacity-60' : ''}`}>
      <CardContent className="space-y-3.5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex-1 whitespace-pre-wrap wrap-break-word text-sm font-medium leading-relaxed text-foreground">
            {bug.text}
          </div>
          <button
            onClick={() => onDelete(bug.id)}
            aria-label="Удалить тикет"
            className="shrink-0 self-end rounded border border-transparent p-1 text-xs text-muted-foreground transition-colors hover:border-border hover:text-destructive sm:self-auto"
            title="Удалить"
          >
            ✕
          </button>
        </div>

        {/* Diagnostic context (crash reports carry trace id / route / componentStack as JSON here) —
            collapsed by default, rendered as plain text (never HTML). */}
        {bug.context && (
          <details className="text-2xs">
            <summary className="cursor-pointer select-none text-muted-foreground transition-colors hover:text-foreground">
              Контекст
            </summary>
            <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-border/60 bg-muted/40 p-2 font-mono text-muted-foreground">
              {bug.context}
            </pre>
          </details>
        )}

        <div className="flex flex-col gap-3 border-t border-border/40 pt-2 text-xs sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-2xs text-muted-foreground">
            <span className="font-medium text-foreground">#{bug.id}</span>
            <span className={`rounded px-1.5 py-0.5 font-sans text-2xs font-medium tracking-wide ${currentKindClass}`}>
              {kindLabel}
            </span>
            {crashCount != null && crashCount > 1 && (
              <span
                className="rounded bg-ember/10 px-1.5 py-0.5 font-sans text-2xs font-medium tracking-wide text-ember"
                title={bug.last_seen ? `Последний раз: ${fmt.date(bug.last_seen)}` : undefined}
              >
                ×{fmt.short(crashCount)}
              </span>
            )}
            <span className={`font-sans font-medium ${currentSeverityClass}`}>
              Важность: {SEVERITY_LABELS[bug.severity ?? ''] || bug.severity}
            </span>
            {bug.created_at && <span className="font-sans font-medium">{fmt.date(bug.created_at)}</span>}
          </div>
          <div className="shrink-0">
            <PillSelect
              value={bug.status ?? 'open'}
              options={availableStatuses.map((st) => ({ value: st, label: STATUS_LABELS[st] || st }))}
              onValueChange={handleStatusChange}
              disabled={updateStatusMutation.isPending}
              ariaLabel={`Статус тикета #${bug.id}`}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BugsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/4" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Card><CardContent className="p-5"><Skeleton className="h-20 w-full" /></CardContent></Card>
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}><CardContent className="space-y-3 p-4"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-8 w-full" /></CardContent></Card>
        ))}
      </div>
    </div>
  );
}
