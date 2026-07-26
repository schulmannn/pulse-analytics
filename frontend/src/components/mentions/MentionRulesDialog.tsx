import { useId, useState } from 'react';
import { toast } from 'sonner';
import type { MentionRules, MentionSettings } from '@/api/schemas';
import { useSaveMentionSettings } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const INPUT_CLASS =
  'mt-1.5 w-full resize-none rounded border border-border bg-background px-3 py-2.5 text-sm leading-5 text-foreground outline-hidden placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-primary read-only:cursor-default read-only:text-muted-foreground';

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function validate(rules: MentionRules): string | null {
  if (rules.include_terms.length === 0) return 'Добавьте хотя бы один поисковый термин';
  if (rules.include_terms.length > 12) return 'Можно добавить не больше 12 поисковых терминов';
  if (rules.exclude_terms.length > 30) return 'Можно добавить не больше 30 исключений по тексту';
  if (rules.exclude_sources.length > 50) return 'Можно исключить не больше 50 каналов';
  if ([...rules.include_terms, ...rules.exclude_terms, ...rules.exclude_sources].some((item) => item.length > 80)) {
    return 'Каждое значение должно быть не длиннее 80 символов';
  }
  return null;
}

function ownSourceLabel(settings: MentionSettings): string | null {
  if (settings.own_source.username) return `@${settings.own_source.username}`;
  if (settings.own_source.tg_channel_id) return `ID ${settings.own_source.tg_channel_id}`;
  return null;
}

export function MentionRulesDialog({
  settings,
  onClose,
}: {
  settings: MentionSettings;
  onClose: () => void;
}) {
  const titleId = useId();

  const [include, setInclude] = useState(settings.rules.include_terms.join('\n'));
  const [exclude, setExclude] = useState(settings.rules.exclude_terms.join('\n'));
  const [sources, setSources] = useState(
    settings.rules.exclude_sources.map((value) => (/^\d+$/.test(value) ? value : `@${value}`)).join('\n'),
  );
  const [mode, setMode] = useState<MentionRules['match_mode']>(settings.rules.match_mode);
  const [localError, setLocalError] = useState<string | null>(null);
  const save = useSaveMentionSettings();

  const submit = async () => {
    const rules: MentionRules = {
      include_terms: lines(include),
      exclude_terms: lines(exclude),
      exclude_sources: lines(sources),
      match_mode: mode,
    };
    const error = validate(rules);
    if (error) {
      setLocalError(error);
      return;
    }
    setLocalError(null);
    const result = await save.mutateAsync(rules).catch(() => null);
    if (result) {
      onClose();
      // Диалог закрывается мгновенно — без тоста успех неотличим от отмены (канон CampaignDialog).
      toast('Правила сохранены');
    }
  };

  const ownSource = ownSourceLabel(settings);
  const error = localError ?? (save.error instanceof Error ? save.error.message : null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl gap-0 overflow-y-auto rounded-lg p-0 shadow-2xl">
        <header className="border-b border-border px-6 py-5 pr-12">
          <div>
            <DialogTitle className="pr-0 text-base leading-normal">Правила упоминаний</DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-5">
              Правила относятся только к выбранному Telegram-каналу и применятся при следующем поиске. Архив не удаляется.
            </DialogDescription>
          </div>
        </header>

        <form
          className="space-y-5 px-6 py-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="block text-xs font-medium text-muted-foreground">
            <span className="flex items-center justify-between gap-4">
              <span>Что искать</span>
              <span className="font-normal tabular-nums">до 12</span>
            </span>
            <textarea
              value={include}
              onChange={(event) => setInclude(event.target.value)}
              readOnly={!settings.can_edit}
              rows={3}
              placeholder={'Название бренда\nbrandname'}
              aria-describedby={`${titleId}-matching-help`}
              className={INPUT_CLASS}
            />
            <span id={`${titleId}-matching-help`} className="mt-1.5 block font-normal leading-5 text-muted-foreground">
              Каждая строка — отдельный запрос Telegram. Регистр не важен; диакритика и другая письменность задаются отдельно.
            </span>
          </label>

          <div>
            <span className="text-xs font-medium text-muted-foreground">Совпадение</span>
            <fieldset className="m-0 mt-1.5 inline-flex min-w-0 overflow-hidden rounded-full border border-border p-0">
              <legend className="sr-only">Режим совпадения</legend>
              {([
                ['contains', 'Вхождение'],
                ['word', 'Целое слово'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  disabled={!settings.can_edit}
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  className={cn(
                    'border-r border-border px-3 py-1.5 text-xs last:border-r-0 disabled:cursor-default',
                    mode === value ? 'bg-primary/10 font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted/50',
                  )}
                >
                  {label}
                </button>
              ))}
            </fieldset>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <label className="block text-xs font-medium text-muted-foreground">
              Исключить по тексту
              <textarea
                value={exclude}
                onChange={(event) => setExclude(event.target.value)}
                readOnly={!settings.can_edit}
                rows={4}
                placeholder={'вакансия\nпромокод'}
                className={INPUT_CLASS}
              />
              <span className="mt-1.5 block font-normal leading-5">Пост будет отброшен при любом совпадении.</span>
            </label>

            <label className="block text-xs font-medium text-muted-foreground">
              Исключить каналы
              <textarea
                value={sources}
                onChange={(event) => setSources(event.target.value)}
                readOnly={!settings.can_edit}
                rows={4}
                placeholder={'@channel_name\n123456789'}
                className={INPUT_CLASS}
              />
              <span className="mt-1.5 block font-normal leading-5">По одному @username или числовому ID на строку.</span>
            </label>
          </div>

          {ownSource && (
            <div className="flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-verdant" aria-hidden="true" />
              Собственный канал {ownSource} исключается автоматически.
            </div>
          )}

          {!settings.can_edit && (
            <p className="border-t border-border pt-4 text-xs text-muted-foreground">
              У вас есть доступ к просмотру. Изменять правила и запускать поиск может владелец или администратор.
            </p>
          )}

          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

          <footer className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <button
              type="button"
              onClick={onClose}
              className="btn-pill px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {settings.can_edit ? 'Отмена' : 'Закрыть'}
            </button>
            {settings.can_edit && (
              <Button
                type="submit"
                disabled={save.isPending || lines(include).length === 0}
                size="xs"
                className="px-4"
              >
                {save.isPending ? 'Сохранение…' : 'Сохранить правила'}
              </Button>
            )}
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
