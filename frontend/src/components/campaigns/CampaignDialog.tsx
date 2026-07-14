import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCreateCampaign, useUpdateCampaign } from '@/api/queries';
import type { Campaign, CampaignStatus } from '@/api/schemas';
import { CAMPAIGN_STATUSES, CAMPAIGN_STATUS_LABEL } from '@/api/schemas';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { cn } from '@/lib/utils';

// Приглушённая палитра меток в духе системы (один синий — акцент, остальные тихие).
const COLOR_PRESETS = ['#2d6be0', '#0f9d8f', '#b48a2f', '#c2512d', '#7c5cad', '#6b7280'];

const INPUT_CLASS =
  'mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary';

/**
 * Создание/редактирование кампании — портальный диалог по канону ConfigEditDialog
 * (focus trap, capture-Escape, scroll-lock, backdrop). initial=null → создание.
 * Ошибки (409 «такое имя уже есть», 400 валидация) — inline-текстом, без toast'ов.
 */
export function CampaignDialog({
  initial,
  channelId,
  onClose,
  onSaved,
}: {
  initial: Campaign | null;
  channelId?: number | null;
  onClose: () => void;
  onSaved?: (campaign: Campaign) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [status, setStatus] = useState<CampaignStatus>(
    (CAMPAIGN_STATUSES as readonly string[]).includes(initial?.status ?? '')
      ? (initial?.status as CampaignStatus)
      : 'active',
  );
  const [startDate, setStartDate] = useState(initial?.start_date ?? '');
  const [endDate, setEndDate] = useState(initial?.end_date ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  const create = useCreateCampaign();
  const update = useUpdateCampaign(initial?.id ?? 0);
  const pending = create.isPending || update.isPending;
  const serverError = (create.error ?? update.error) as Error | null;

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
    if (startDate && endDate && endDate < startDate) {
      setLocalError('Дата окончания раньше даты начала');
      return;
    }
    setLocalError(null);
    const body = {
      name: trimmed,
      description,
      color,
      status,
      start_date: startDate || null,
      end_date: endDate || null,
    };
    if (!initial && channelId == null) {
      setLocalError('Сначала выберите источник');
      return;
    }
    const data = initial
      ? await update.mutateAsync(body).catch(() => null)
      : await create.mutateAsync({ ...body, channel_id: channelId! }).catch(() => null);
    if (data) {
      onSaved?.(data.campaign);
      onClose();
    }
  };

  const error = localError ?? (serverError ? serverError.message : null);

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-start justify-center overflow-y-auto bg-background/70 p-4 backdrop-blur-sm backdrop-grayscale sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={initial ? `Изменение кампании «${initial.name}»` : 'Новая кампания'}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="my-auto w-full max-w-md rounded-xl border border-border bg-card p-5 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-medium text-foreground">
          {initial ? 'Изменить кампанию' : 'Новая кампания'}
        </h2>

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
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Запуск продукта"
              className={INPUT_CLASS}
            />
          </label>

          <label className="block text-xs font-medium text-muted-foreground">
            Описание
            <textarea
              value={description ?? ''}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Необязательно: что объединяет эти публикации"
              className={cn(INPUT_CLASS, 'resize-none')}
            />
          </label>

          <div>
            <span className="text-xs font-medium text-muted-foreground">Метка</span>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setColor(null)}
                aria-pressed={color == null}
                title="Без цвета"
                className={cn(
                  'flex size-6 items-center justify-center rounded-full border text-2xs text-muted-foreground',
                  color == null ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-muted-foreground',
                )}
              >
                —
              </button>
              {COLOR_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setColor(preset)}
                  aria-pressed={color === preset}
                  aria-label={`Цвет ${preset}`}
                  className={cn(
                    'size-6 rounded-full border border-transparent transition-transform',
                    color === preset ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : 'hover:scale-110',
                  )}
                  style={{ backgroundColor: preset }}
                />
              ))}
            </div>
          </div>

          <div>
            <span className="text-xs font-medium text-muted-foreground">Статус</span>
            <div className="mt-1.5 flex overflow-hidden rounded border border-border">
              {CAMPAIGN_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={status === s}
                  onClick={() => setStatus(s)}
                  className={cn(
                    'flex-1 border-r border-border px-2 py-1.5 text-xs transition-colors last:border-r-0',
                    status === s ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted/50',
                  )}
                >
                  {CAMPAIGN_STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-muted-foreground">
              Начало
              <input type="date" value={startDate ?? ''} onChange={(e) => setStartDate(e.target.value)} className={INPUT_CLASS} />
            </label>
            <label className="block text-xs font-medium text-muted-foreground">
              Окончание
              <input type="date" value={endDate ?? ''} onChange={(e) => setEndDate(e.target.value)} className={INPUT_CLASS} />
            </label>
          </div>

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
              disabled={pending || !name.trim()}
              className="btn-pill bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {pending ? 'Сохранение…' : initial ? 'Сохранить' : 'Создать'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
