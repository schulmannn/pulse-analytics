import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useChannels, useCreateReport } from '@/api/queries';
import type { ReportSchedule } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import type { ReportBlockKey } from '@/lib/reportBlocks';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { PERIOD_CHIPS } from '@/panels/report/blocks';
import type { PeriodDays } from '@/lib/period';
import { PillSelect } from '@/components/PillSelect';
import { cn } from '@/lib/utils';

// Create-time templates: a compact set of curated starting points (selectable rows, not cards).
// «Еженедельный обзор» leads and is recommended; «Пустой» starts an empty document the owner
// composes by hand. Blocks are preset keys — the server stores them and normalizeBlocks migrates.
const TEMPLATES: Array<{ id: string; name: string; description: string; blocks: ReportBlockKey[]; recommended?: boolean }> = [
  {
    id: 'weekly',
    name: 'Еженедельный обзор',
    description: 'Изменения, ключевые метрики и лучшие публикации.',
    blocks: ['week', 'kpi-summary', 'metric-views', 'top-posts'],
    recommended: true,
  },
  {
    id: 'growth',
    name: 'Рост аудитории',
    description: 'Подписчики, недельная динамика и наблюдения.',
    blocks: ['kpi-summary', 'metric-subscribers', 'weekly-table', 'insights'],
  },
  {
    id: 'content',
    name: 'Эффективность контента',
    description: 'Охват, реакции и публикации, которые дали результат.',
    blocks: ['kpi-summary', 'metric-views', 'metric-reactions', 'top-posts', 'insights'],
  },
  {
    id: 'blank',
    name: 'Пустой',
    description: 'Начать с чистого документа и собрать блоки самому.',
    blocks: [],
  },
];

const INPUT_CLASS =
  'mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary';

/**
 * Портальный диалог создания отчёта по канону CampaignDialog (focus trap, capture-Escape,
 * scroll-lock, backdrop, inline errors). Собирает название, шаблон, закреплённый Telegram-источник,
 * период и доставку → один POST → переход в новый отчёт. Источник по умолчанию — текущий канал.
 */
export function CreateReportDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const createReport = useCreateReport();
  const { channelId: selectedChannelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const channels = useMemo(
    () => (channelsData?.channels ?? []).filter((channel) => channel.source !== 'ig'),
    [channelsData],
  );

  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const defaultSource = channels.some((channel) => channel.id === selectedChannelId)
    ? selectedChannelId
    : channels[0]?.id ?? null;
  const [source, setSource] = useState<number | null>(defaultSource);
  const [periodDays, setPeriodDays] = useState<PeriodDays>(30);
  const [schedule, setSchedule] = useState<ReportSchedule>('none');
  const [localError, setLocalError] = useState<string | null>(null);

  // Once channels load, adopt the current channel as the default source (if the user hasn't picked).
  const touchedSource = useRef(false);
  useEffect(() => {
    if (touchedSource.current) return;
    if (source == null && defaultSource != null) setSource(defaultSource);
  }, [defaultSource, source]);

  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setLocalError('Название обязательно');
      return;
    }
    if (source == null) {
      setLocalError('Нет доступного Telegram-источника');
      return;
    }
    setLocalError(null);
    const template = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];
    const blocks: ReportBlockKey[] = template.id === 'blank' ? [] : [...template.blocks];
    const config: Record<string, unknown> = { blocks, periodDays };
    config.channelId = source;
    const data = await createReport
      .mutateAsync({ name: trimmed, config, schedule })
      .catch(() => null);
    if (data) {
      onClose();
      navigate(`/reports/${data.report.id}`);
    }
  };

  const serverError = createReport.error as Error | null;
  const error = localError ?? (serverError ? serverError.message : null);
  const pending = createReport.isPending;

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-start justify-center overflow-y-auto bg-background/70 p-4 backdrop-blur-sm backdrop-grayscale sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Новый отчёт"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="my-auto w-full max-w-lg rounded-lg border border-border bg-card p-5 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-medium text-foreground">Новый отчёт</h2>

        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block text-xs font-medium text-muted-foreground">
            Название
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Например, Итоги недели"
              className={INPUT_CLASS}
            />
          </label>

          <div>
            <span className="text-xs font-medium text-muted-foreground">Шаблон</span>
            <div className="mt-1.5 overflow-hidden rounded border border-border" role="radiogroup" aria-label="Шаблон">
              {TEMPLATES.map((t, i) => {
                const active = t.id === templateId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTemplateId(t.id)}
                    role="radio"
                    aria-checked={active}
                    className={cn(
                      'flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors',
                      i > 0 && 'border-t border-border',
                      active ? 'bg-primary/10' : 'hover:bg-muted/50',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                        active ? 'border-primary' : 'border-muted-foreground/50',
                      )}
                    >
                      {active && <span className="size-2 rounded-full bg-primary" />}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                        {t.name}
                        {t.recommended && (
                          <span className="rounded-full bg-secondary px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                            Рекомендуем
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{t.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block text-xs font-medium text-muted-foreground">
            Источник · Telegram
            <PillSelect
              ariaLabel="Источник · Telegram"
              className="mt-1 w-full"
              value={String(source ?? '')}
              options={
                channels.length === 0
                  ? [{ value: '', label: 'Нет доступных каналов', disabled: true }]
                  : channels.map((c) => ({
                      value: String(c.id),
                      label: c.username ? `@${c.username}` : c.title || `Источник #${c.id}`,
                    }))
              }
              onValueChange={(v) => {
                touchedSource.current = true;
                setSource(v ? Number(v) : null);
              }}
            />
          </label>

          <div>
            <span className="text-xs font-medium text-muted-foreground">Период</span>
            <div className="mt-1.5 flex overflow-hidden rounded border border-border">
              {PERIOD_CHIPS.map((chip) => (
                <button
                  key={chip.days}
                  type="button"
                  aria-pressed={periodDays === chip.days}
                  onClick={() => setPeriodDays(chip.days)}
                  className={cn(
                    'flex-1 border-r border-border px-2 py-1.5 text-xs font-medium transition-colors last:border-r-0',
                    periodDays === chip.days ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50',
                  )}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>

          <label className="block text-xs font-medium text-muted-foreground">
            Доставка на почту
            <PillSelect<ReportSchedule>
              ariaLabel="Доставка на почту"
              className="mt-1 w-full"
              value={schedule}
              options={[
                { value: 'none', label: 'Выкл' },
                { value: 'weekly', label: 'Раз в неделю — письмо со ссылкой' },
                { value: 'monthly', label: 'Раз в месяц — письмо со ссылкой' },
              ]}
              onValueChange={(v) => setSchedule(v)}
            />
          </label>

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <button
              type="button"
              onClick={onClose}
              className="btn-pill px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={pending || !name.trim() || source == null}
              className="btn-pill bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {pending ? 'Создание…' : 'Создать отчёт'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
