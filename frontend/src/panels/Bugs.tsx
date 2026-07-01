import { useState, type FormEvent, type ChangeEvent } from 'react';
import { useBugs, useCreateBug, useUpdateBugStatus, useDeleteBug } from '@/api/queries';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmt } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';

const KIND_LABELS: Record<string, string> = { bug: 'Баг', feature: 'Фича', change: 'Правка' };
const SEVERITY_LABELS: Record<string, string> = { low: 'Низкая', medium: 'Средняя', high: 'Высокая' };
const STATUS_LABELS: Record<string, string> = { open: 'Открыт', in_progress: 'В работе', done: 'Готово', wont_fix: 'Не баг' };

export function Bugs() {
  const { data, isLoading, isError, error } = useBugs();
  const createBugMutation = useCreateBug();
  const deleteBugMutation = useDeleteBug();

  const [textInput, setTextInput] = useState('');
  const [kindInput, setKindInput] = useState('bug');
  const [severityInput, setSeverityInput] = useState('medium');

  if (isLoading) return <BugsSkeleton />;
  if (isError) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Ошибка загрузки баг-трекера: {error instanceof Error ? error.message : 'ошибка сервера'}
        </CardContent>
      </Card>
    );
  }

  if (data?.enabled === false) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          БД не подключена. Баг-трекер недоступен.
        </CardContent>
      </Card>
    );
  }

  const bugs = data?.bugs ?? [];
  const availableStatuses = data?.statuses ?? ['open', 'in_progress', 'done', 'wont_fix'];

  const handleSubmitBug = async (e: FormEvent) => {
    e.preventDefault();
    const cleanText = textInput.trim();
    if (!cleanText) return;
    try {
      await createBugMutation.mutateAsync({ text: cleanText, kind: kindInput, severity: severityInput, context: 'source=telegram' });
      setTextInput('');
      setKindInput('bug');
      setSeverityInput('medium');
    } catch {
      alert('Не удалось отправить тикет');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-medium tracking-tight">Баг-трекер</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Дефекты интерфейса, идеи и правки</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium tracking-wide text-muted-foreground">Сообщить о баге / предложить фичу</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmitBug} className="space-y-4">
            <textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Опишите проблему или предложение…"
              rows={3}
              disabled={createBugMutation.isPending}
              className="w-full resize-y rounded border bg-background p-2.5 text-sm leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
            />
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <select
                  value={kindInput}
                  onChange={(e) => setKindInput(e.target.value)}
                  disabled={createBugMutation.isPending}
                  className="rounded border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {Object.entries(KIND_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
                <select
                  value={severityInput}
                  onChange={(e) => setSeverityInput(e.target.value)}
                  disabled={createBugMutation.isPending}
                  className="rounded border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {Object.entries(SEVERITY_LABELS).map(([s, label]) => (
                    <option key={s} value={s}>{label}</option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                disabled={createBugMutation.isPending || !textInput.trim()}
                className="rounded bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {createBugMutation.isPending ? 'Отправка…' : 'Создать тикет'}
              </button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h3 className="px-1 text-xs font-medium tracking-wider text-muted-foreground">Тикеты</h3>
        {bugs.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/20 py-8 text-center text-sm text-muted-foreground">
            Багов пока нет.
          </div>
        ) : (
          <div className="space-y-3">
            {bugs.map((bug) => (
              <BugRowCard
                key={bug.id}
                bug={bug}
                availableStatuses={availableStatuses}
                onDelete={(id) => {
                  if (window.confirm('Удалить запись из баг-трекера?')) deleteBugMutation.mutate(id);
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
  };
  const severityColors: Record<string, string> = { high: 'text-ember', low: 'text-verdant', medium: 'text-primary' };
  const currentKindClass = kindColors[bug.kind ?? ''] || 'text-muted-foreground bg-muted';
  const currentSeverityClass = severityColors[bug.severity ?? ''] || 'text-muted-foreground';

  const handleStatusChange = (e: ChangeEvent<HTMLSelectElement>) => updateStatusMutation.mutate({ status: e.target.value });

  return (
    <Card className={`transition-opacity ${isCompleted ? 'opacity-60' : ''}`}>
      <CardContent className="space-y-3.5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex-1 whitespace-pre-wrap break-words text-sm font-medium leading-relaxed text-foreground">
            {bug.text}
          </div>
          <button
            onClick={() => onDelete(bug.id)}
            className="shrink-0 self-end rounded border border-transparent p-1 text-xs text-muted-foreground transition-colors hover:border-border hover:text-destructive sm:self-auto"
            title="Удалить"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-3 border-t border-border/40 pt-2 text-xs sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-2xs text-muted-foreground">
            <span className="font-medium text-foreground">#{bug.id}</span>
            <span className={`rounded px-1.5 py-0.5 font-sans text-2xs font-medium tracking-wide ${currentKindClass}`}>
              {KIND_LABELS[bug.kind ?? ''] || bug.kind}
            </span>
            <span className={`font-sans font-medium ${currentSeverityClass}`}>
              Важность: {SEVERITY_LABELS[bug.severity ?? ''] || bug.severity}
            </span>
            {bug.created_at && <span className="font-sans font-medium">{fmt.date(bug.created_at)}</span>}
          </div>
          <div className="shrink-0">
            <select
              value={bug.status ?? 'open'}
              onChange={handleStatusChange}
              disabled={updateStatusMutation.isPending}
              className="rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
            >
              {availableStatuses.map((st) => (
                <option key={st} value={st}>{STATUS_LABELS[st] || st}</option>
              ))}
            </select>
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
