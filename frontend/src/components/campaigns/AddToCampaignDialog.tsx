import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAddCampaignPosts, useCampaigns, useCreateCampaign } from '@/api/queries';
import type { Campaign, CampaignAddResult, CampaignPostInput } from '@/api/schemas';
import { CampaignColorDot, CampaignStatusChip, canEditCampaign } from '@/components/campaigns/shared';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/lib/format';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { cn } from '@/lib/utils';

/**
 * «Добавить в кампанию» для bulk-выбора публикаций. Список доступных для записи кампаний
 * (viewer-кампании скрыты — сервер всё равно ответит 403) + инлайн-создание новой. После
 * добавления показывает честный итог: added / уже были (идемпотентный повтор) / не найдены.
 */
export function AddToCampaignDialog({
  items,
  onClose,
  onDone,
}: {
  items: CampaignPostInput[];
  onClose: () => void;
  onDone?: (result: CampaignAddResult, campaign: Campaign) => void;
}) {
  const channelId = items[0]?.channel_id ?? null;
  const { data, isPending, isError } = useCampaigns(channelId);
  const writable = useMemo(
    () => (data?.campaigns ?? []).filter((c) => canEditCampaign(c) && c.status !== 'archived'),
    [data],
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createMode, setCreateMode] = useState(false);
  const [newName, setNewName] = useState('');
  const [result, setResult] = useState<{ res: CampaignAddResult; campaign: Campaign } | null>(null);

  const add = useAddCampaignPosts();
  const create = useCreateCampaign();
  const pending = add.isPending || create.isPending;
  const mutationError = (add.error ?? create.error) as Error | null;

  useEffect(() => {
    if (selectedId == null && writable.length > 0) setSelectedId(writable[0]!.id);
    if (writable.length === 0 && !isPending) setCreateMode(true);
  }, [selectedId, writable, isPending]);

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
    let campaign: Campaign | null = null;
    if (createMode) {
      const name = newName.trim();
      if (!name) return;
      if (channelId == null) return;
      const created = await create.mutateAsync({ name, channel_id: channelId }).catch(() => null);
      if (!created) return;
      campaign = created.campaign;
    } else {
      campaign = writable.find((c) => c.id === selectedId) ?? null;
    }
    if (!campaign) return;
    const res = await add.mutateAsync({ campaignId: campaign.id, items }).catch(() => null);
    if (res) {
      setResult({ res, campaign });
      onDone?.(res, campaign);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-start justify-center overflow-y-auto bg-background/70 p-4 backdrop-blur-sm backdrop-grayscale sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Добавить публикации в кампанию"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="my-auto w-full max-w-md rounded-xl border border-border bg-card p-5 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {result ? (
          <div data-testid="add-to-campaign-result">
            <h2 className="text-sm font-medium text-foreground">
              Кампания «{result.campaign.name}»
            </h2>
            <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
              <li>
                Добавлено: <span className="font-medium text-foreground">{fmt.num(result.res.added)}</span>
              </li>
              {result.res.skipped > 0 && <li>Уже были в кампании: {fmt.num(result.res.skipped)}</li>}
              {result.res.invalid.length > 0 && <li>Не найдены в архиве: {fmt.num(result.res.invalid.length)}</li>}
            </ul>
            <div className="mt-4 flex justify-end border-t border-border pt-4">
              <button
                type="button"
                onClick={onClose}
                className="btn-pill bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Готово
              </button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="text-sm font-medium text-foreground">
              Добавить в кампанию · {fmt.num(items.length)} публ.
            </h2>

            {isPending ? (
              <div className="mt-4 space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : isError ? (
              <p className="mt-4 text-xs text-destructive">Не удалось загрузить список кампаний.</p>
            ) : (
              <div className="mt-4 space-y-3">
                {!createMode && writable.length > 0 && (
                  <div className="max-h-64 space-y-0.5 overflow-y-auto" role="radiogroup" aria-label="Кампания">
                    {writable.map((c) => (
                      <label
                        key={c.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-sm transition-colors hover:bg-muted/40',
                          selectedId === c.id ? 'bg-primary/10' : '',
                        )}
                      >
                        <input
                          type="radio"
                          name="campaign"
                          checked={selectedId === c.id}
                          onChange={() => setSelectedId(c.id)}
                          className="size-4 shrink-0 accent-primary"
                        />
                        <CampaignColorDot color={c.color} />
                        <span className="min-w-0 flex-1 truncate text-foreground">{c.name}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">{fmt.num(c.post_count ?? 0)}</span>
                        <CampaignStatusChip status={c.status} />
                      </label>
                    ))}
                  </div>
                )}
                {!createMode && writable.length === 0 && (
                  <EmptyState compact title="Кампаний пока нет — создайте первую." />
                )}

                {createMode ? (
                  <label className="block text-xs font-medium text-muted-foreground">
                    Название новой кампании
                    <input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      maxLength={120}
                      placeholder="Запуск продукта"
                      className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
                    />
                  </label>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCreateMode(true)}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    + Новая кампания
                  </button>
                )}
                {createMode && writable.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCreateMode(false)}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    ← Выбрать существующую
                  </button>
                )}

                {mutationError && (
                  <p role="alert" className="text-xs text-destructive">
                    {mutationError.message}
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
                    type="button"
                    onClick={() => void submit()}
                    disabled={pending || (createMode ? !newName.trim() : selectedId == null)}
                    className="btn-pill bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {pending ? 'Добавление…' : 'Добавить'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
