import { useState } from 'react';
import { toast } from 'sonner';
import type { CdekInclude } from '@/api/cdek';
import { SearchField } from '@/components/SearchField';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Фильтр статусов для метрик СДЭКа: какие заказы вообще попадают в число.
 *
 * Раньше выбор был зашит: «отгруженное = проданное», то есть всё кроме отмен и возвратов, и
 * карточка носила об этом постоянную подпись. Теперь набор выбирает человек — а значит подпись
 * обязана следовать выбору, иначе на экране окажется число, которое называется не тем, чем
 * является. Отсюда `statusFilterCaption`: она печатается ТОЛЬКО когда выбор отличается от
 * канонического, и говорит ровно то, что посчитано.
 *
 * Выбор едет на сервер тем же параметром `include`, который и так означал «что считать выручкой»
 * (см. normalizeCdekInclude в server/repos/cdekRepo): три прежних режима плюс явный набор
 * `status:complete,delivery`. Сервер сортирует и чистит набор, поэтому один и тот же выбор всегда
 * даёт одну строку — и один ключ кэша.
 */
export const CDEK_STATUSES = [
  { id: 'complete', label: 'Завершён' },
  { id: 'delivery', label: 'В доставке' },
  { id: 'cancel', label: 'Отменён' },
  { id: 'return', label: 'Возврат' },
] as const;

/**
 * Канон: продано = отгружено. Он же — НАЧАЛЬНОЕ состояние фильтра, а не пустой набор: иначе первый
 * клик по «Отменён» означал бы «показать только отменённые», хотя человек добавлял их к тому, что
 * уже видит на экране.
 */
export const CDEK_CANON_STATUSES = ['complete', 'delivery'];
const CANON = CDEK_CANON_STATUSES;

const sortedUnique = (ids: readonly string[]): string[] =>
  [...new Set(ids)].filter((id) => CDEK_STATUSES.some((s) => s.id === id)).sort();

export const normalizeCdekStatuses = (ids: readonly string[] | undefined | null): string[] =>
  sortedUnique(ids ?? []);

export const sameCdekStatuses = (a: readonly string[], b: readonly string[]): boolean => {
  const [x, y] = [sortedUnique(a), sortedUnique(b)];
  return x.length === y.length && x.every((id, i) => id === y[i]);
};

/** Ключ сохранённого фильтра — по каналу: у каждого склада свой набор. */
export const cdekStatusFilterKey = (channelId: number | null | undefined): string =>
  `cdek:status:${channelId ?? 0}`;

/**
 * Значение параметра `include` для выбранного набора. Пустой выбор — это «выбора нет», а не «ноль
 * заказов»: показывать ноль там, где человек просто ничего не отметил, значит соврать про склад.
 */
export function cdekStatusInclude(selected: readonly string[]): CdekInclude {
  const picked = sortedUnique(selected);
  if (picked.length === 0) return 'revenue';
  if (picked.length === CDEK_STATUSES.length) return 'all';
  if (sameCdekStatuses(picked, CANON)) return 'revenue';
  return `status:${picked.join(',')}` as CdekInclude;
}

/** Подпись под числом — только когда выбор ушёл от канона. Иначе на карточке нет лишней строки. */
export function statusFilterCaption(selected: readonly string[]): string | null {
  const picked = sortedUnique(selected);
  if (picked.length === 0 || sameCdekStatuses(picked, CANON)) return null;
  if (picked.length === CDEK_STATUSES.length) return 'Считаются заказы всех статусов';
  const labels = picked.map((id) => CDEK_STATUSES.find((s) => s.id === id)?.label ?? id);
  return `Считаются только: ${labels.join(', ').toLocaleLowerCase('ru-RU')}`;
}

/**
 * Сохранения ЗДЕСЬ нет. Раньше у каждого фильтра была своя кнопка «Сохранить», и человек, поменяв
 * обе оси одного вопроса «что считать», должен был нажать две. Кнопка теперь одна на страницу, в
 * её правом верхнем углу (владелец), и сохраняет весь выбор разом.
 */
export function CdekStatusFilter({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    // Заголовок «Статусы заказов» уже занят карточкой разбивки на «Обзоре» — фильтру нужен свой
    // якорь, иначе тест «фильтра на карточке нет» ловил бы чужой текст и зеленел вхолостую.
    <div className="space-y-2" data-cdek-status-filter="">
      <span className="text-xs text-muted-foreground">Какие заказы считать</span>
      <div className="flex flex-wrap gap-1.5">
        {CDEK_STATUSES.map((status) => {
          const active = selected.includes(status.id);
          return (
            <button
              key={status.id}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(status.id)}
              className={cn(
                'min-h-11 rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50 sm:min-h-0',
                active
                  ? 'border-primary bg-primary/10 font-medium text-accent-foreground'
                  : 'border-border bg-background text-ink2 hover:bg-muted hover:text-foreground',
              )}
            >
              {status.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Общий тост сохранения — текст один и там, где фильтр сбрасывают, и там, где задают. */
export const toastStatusFilterSaved = (ids: readonly string[]): void => {
  toast(sortedUnique(ids).length === 0 ? 'Фильтр сброшен: канон СДЭКа' : 'Фильтр статусов сохранён');
};

// ── Фильтр по товарам ─────────────────────────────────────────────────────────────────────────
/**
 * Тот же вопрос «что считать», только по другой оси. Живёт рядом со статусами намеренно: два
 * фильтра одной метрики должны читаться как один блок, а не как две независимые панели.
 *
 * Фильтр режет СТРОКИ ПОЗИЦИЙ (см. saleRows в server/repos/cdekRepo): выручка становится суммой
 * выбранных товаров, «Заказы» — заказами, в которых они есть, «Штук» — их штуками. Все три числа
 * отвечают на один вопрос, а не на три разных.
 */
export const cdekProductFilterKey = (channelId: number | null | undefined): string =>
  `cdek:products:${channelId ?? 0}`;

/**
 * Потолок выбора — ТОТ ЖЕ, что у сервера (PRODUCT_FILTER_MAX в server/repos/cdekRepo). Сервер на
 * переборе отвечает отказом, а не срезает хвост молча; чтобы в этот отказ нельзя было упереться
 * случайно, дальше потолка кнопки просто не нажимаются и рядом стоит причина.
 */
export const CDEK_PRODUCT_MAX = 50;

export interface CdekProductOption {
  id: string;
  name: string;
}

export const normalizeCdekProducts = (ids: readonly string[] | undefined | null): string[] =>
  [...new Set(ids ?? [])].map((id) => id.trim()).filter(Boolean).sort();

export const sameCdekProducts = (a: readonly string[], b: readonly string[]): boolean => {
  const [x, y] = [normalizeCdekProducts(a), normalizeCdekProducts(b)];
  return x.length === y.length && x.every((id, i) => id === y[i]);
};

/** Подпись — только когда выбор сделан: без него метрика считает весь ассортимент, как и раньше. */
export function productFilterCaption(
  selected: readonly string[],
  options: readonly CdekProductOption[],
): string | null {
  const picked = normalizeCdekProducts(selected);
  if (picked.length === 0) return null;
  if (picked.length === 1) {
    const name = options.find((o) => o.id === picked[0])?.name ?? picked[0];
    return `Только товар: ${name}`;
  }
  return `Только выбранные товары: ${picked.length}`;
}

export function CdekProductFilter({
  options,
  selected,
  onChange,
}: {
  options: CdekProductOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  // Свёрнут по умолчанию: список ассортимента длиннее экрана, и раскрытый он сталкивал бы график
  // под сгиб при каждом заходе (тот же приём, что у фильтра каналов МойСклада).
  const [open, setOpen] = useState(false);
  const needle = query.trim().toLocaleLowerCase('ru-RU');
  const visible = needle
    ? options.filter((o) => o.name.toLocaleLowerCase('ru-RU').includes(needle))
    : options;
  const full = selected.length >= CDEK_PRODUCT_MAX;
  const toggle = (id: string) => {
    if (selected.includes(id)) return onChange(selected.filter((x) => x !== id));
    if (full) return;
    onChange([...selected, id]);
  };

  return (
    <div className="space-y-2" data-cdek-product-filter="">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Товары{selected.length > 0 ? ` · выбрано ${selected.length}` : ' · все'}
        </button>
        <div className="flex items-center gap-2">
          {selected.length > 0 && (
            <Button type="button" variant="ghost" size="xs" onClick={() => onChange([])}>
              Сбросить
            </Button>
          )}
        </div>
      </div>
      {open && (
        <div className="space-y-2 rounded-lg border border-border p-2.5">
          <SearchField value={query} onChange={setQuery} ariaLabel="Поиск товара" placeholder="Название товара" />
          {full && (
            <p className="px-1 text-2xs text-muted-foreground">
              Выбрано максимум — {CDEK_PRODUCT_MAX}. Снимите лишний, чтобы добавить другой.
            </p>
          )}
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">Ничего не нашлось.</p>
            ) : (
              visible.map((option) => {
                const active = selected.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    disabled={!active && full}
                    onClick={() => toggle(option.id)}
                    className={cn(
                      'flex min-h-11 w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-45 sm:min-h-0',
                      active ? 'bg-primary/10 text-foreground' : 'text-ink2 hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 rounded-sm border',
                        active ? 'border-primary bg-primary' : 'border-border',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Фильтр по каналу продаж ───────────────────────────────────────────────────────────────────
/**
 * Третья ось того же вопроса «что считать»: статус — КАК закончился заказ, товар — ЧТО продано,
 * канал — ГДЕ продано (владелец: «фильтр по источнику продаж, например яндекс маркет, или
 * wildberries или сайт»).
 *
 * Ключи те же, что кладёт импорт (server/domain/cdekImport → SALES_CHANNELS); человеческие
 * подписи живут здесь, чтобы переименование витрины не требовало переигрывать импорты.
 */
export const CDEK_SALES_CHANNELS = [
  { id: 'own', label: 'Своя доставка' },
  { id: 'wildberries', label: 'Wildberries' },
  { id: 'yandex_market', label: 'Яндекс.Маркет' },
  { id: 'ozon', label: 'Ozon' },
  { id: 'other', label: 'Другая служба' },
] as const;

export const cdekChannelFilterKey = (channelId: number | null | undefined): string =>
  `cdek:sales-channels:${channelId ?? 0}`;

export const normalizeCdekChannels = (ids: readonly string[] | undefined | null): string[] =>
  [...new Set(ids ?? [])].filter((id) => CDEK_SALES_CHANNELS.some((c) => c.id === id)).sort();

export const sameCdekChannels = (a: readonly string[], b: readonly string[]): boolean => {
  const [x, y] = [normalizeCdekChannels(a), normalizeCdekChannels(b)];
  return x.length === y.length && x.every((id, i) => id === y[i]);
};

/** Подпись — только когда выбор сужает. Полный набор и пустой одинаково означают «все каналы». */
export function channelFilterCaption(selected: readonly string[]): string | null {
  const picked = normalizeCdekChannels(selected);
  if (picked.length === 0 || picked.length === CDEK_SALES_CHANNELS.length) return null;
  const labels = picked.map((id) => CDEK_SALES_CHANNELS.find((c) => c.id === id)?.label ?? id);
  return `Только каналы: ${labels.join(', ')}`;
}

export function CdekChannelFilter({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    <div className="space-y-2" data-cdek-channel-filter="">
      <span className="text-xs text-muted-foreground">
        Каналы продаж{selected.length > 0 ? ` · выбрано ${selected.length}` : ' · все'}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {CDEK_SALES_CHANNELS.map((channel) => {
          const active = selected.includes(channel.id);
          return (
            <button
              key={channel.id}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(channel.id)}
              className={cn(
                'min-h-11 rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50 sm:min-h-0',
                active
                  ? 'border-primary bg-primary/10 font-medium text-accent-foreground'
                  : 'border-border bg-background text-ink2 hover:bg-muted hover:text-foreground',
              )}
            >
              {channel.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
