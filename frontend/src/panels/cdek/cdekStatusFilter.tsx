import { toast } from 'sonner';
import type { CdekInclude } from '@/api/cdek';
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

export function CdekStatusFilter({
  selected,
  saved,
  onChange,
  onSave,
}: {
  selected: string[];
  saved: string[];
  onChange: (ids: string[]) => void;
  onSave: (ids: string[]) => void;
}) {
  const dirty = !sameCdekStatuses(selected, saved);
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    // Заголовок «Статусы заказов» уже занят карточкой разбивки на «Обзоре» — фильтру нужен свой
    // якорь, иначе тест «фильтра на карточке нет» ловил бы чужой текст и зеленел вхолостую.
    <div className="space-y-2" data-cdek-status-filter="">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Какие заказы считать</span>
        {dirty && (
          <Button type="button" variant="secondary" size="xs" onClick={() => onSave(selected)}>
            Сохранить
          </Button>
        )}
      </div>
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
