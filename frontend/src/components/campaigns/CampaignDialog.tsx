import { useState } from 'react';
import { useCreateCampaign, useUpdateCampaign } from '@/api/queries';
import type { Campaign, CampaignStatus } from '@/api/schemas';
import { CAMPAIGN_STATUSES, CAMPAIGN_STATUS_LABEL } from '@/api/schemas';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// Приглушённая палитра меток в духе системы (один синий — акцент, остальные тихие).
const COLOR_PRESETS = [
  '#2d6be0',
  '#0f9d8f',
  '#b48a2f',
  '#c2512d',
  '#7c5cad',
  '#6b7280',
];

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
      : await create
          .mutateAsync({ ...body, channel_id: channelId! })
          .catch(() => null);
    if (data) {
      onSaved?.(data.campaign);
      onClose();
    }
  };

  const error = localError ?? (serverError ? serverError.message : null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {initial ? 'Изменить кампанию' : 'Новая кампания'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {initial
              ? `Изменение кампании «${initial.name}»`
              : 'Создание новой кампании'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="campaign-name">Название</Label>
            <Input
              id="campaign-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Запуск продукта"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="campaign-description">Описание</Label>
            <Textarea
              id="campaign-description"
              value={description ?? ''}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Необязательно: что объединяет эти публикации"
              className="resize-none"
            />
          </div>

          <div>
            <Label asChild>
              <span>Метка</span>
            </Label>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setColor(null)}
                aria-pressed={color == null}
                title="Без цвета"
                className={cn(
                  'flex size-6 items-center justify-center rounded-full border text-2xs text-muted-foreground',
                  color == null
                    ? 'border-primary ring-1 ring-primary'
                    : 'border-border hover:border-muted-foreground',
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
                    color === preset
                      ? 'ring-2 ring-primary ring-offset-2 ring-offset-card'
                      : 'hover:scale-110',
                  )}
                  style={{ backgroundColor: preset }}
                />
              ))}
            </div>
          </div>

          <div>
            <Label asChild>
              <span>Статус</span>
            </Label>
            <div className="mt-1.5 flex overflow-hidden rounded-full border border-border">
              {CAMPAIGN_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={status === s}
                  onClick={() => setStatus(s)}
                  className={cn(
                    'flex-1 border-r border-border px-2 py-1.5 text-xs transition-colors last:border-r-0',
                    status === s
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted/50',
                  )}
                >
                  {CAMPAIGN_STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="campaign-start">Начало</Label>
              <Input
                id="campaign-start"
                type="date"
                value={startDate ?? ''}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="campaign-end">Окончание</Label>
              <Input
                id="campaign-end"
                type="date"
                value={endDate ?? ''}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <Alert variant="destructive" className="py-2.5">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" size="sm" disabled={pending || !name.trim()}>
              {pending ? 'Сохранение…' : initial ? 'Сохранить' : 'Создать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
