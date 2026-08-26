import { useMemo, useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  CDEK_CANON_STATUSES,
  CDEK_SALES_CHANNELS,
  CDEK_STATUSES,
  CdekChannelFilter,
  CdekProductFilter,
  CdekStatusFilter,
  normalizeCdekChannels,
  normalizeCdekProducts,
  normalizeCdekStatuses,
  sameCdekStatuses,
  type CdekProductOption,
} from '@/panels/cdek/cdekStatusFilter';

/**
 * Список фильтров правой колонки — анатомия снята ЗАМЕРОМ с метрик Steep (владелец: «посмотри как
 * сделано у Steep и сделай также»), а не по памяти о скриншоте:
 *
 *   строка раздела   32px, значок 16px приглушённый, 10px до названия, «+» 28×28 у правого края
 *   название         обычный размер, ОСНОВНОЙ цвет, средний вес — заголовок списка, не микроподпись
 *   элемент          та же вертикаль, что у названия; приглушённый цвет, обычный вес; 32px
 *   поповер          узкий (~180px), пункты 32px
 *
 * Первый заход был компактным блоком с мелкой текстовой кнопкой внизу — механика та, анатомия
 * чужая, владелец это и забраковал.
 *
 * ГЛАВНОЕ УСТРОЙСТВО (оно же причина всей затеи): ось не нарисована, пока её не добавили. Раньше
 * колонка держала три оси развёрнутыми — одиннадцать чипов на экране всегда, — и каждый новый
 * статус или канал отвоёвывал себе место. Теперь их число на раскладку не влияет вовсе.
 *
 * ПУСТОЕ СОСТОЯНИЕ НЕ МОЛЧИТ. У Steep «фильтр не добавлен» значит «не фильтруем», у нас — нет:
 * канон исключает отмены, возвраты, собранные и подтверждённые. Пустая колонка читалась бы как
 * «считается всё», поэтому там стоит строка о том, что посчитано.
 *
 * «ДОБАВЛЕННОСТЬ» НЕ ХРАНИТСЯ: ось видна, если её выбор отличается от умолчания, плюс открытые в
 * этой сессии. Отдельный ключ умел бы разойтись с тремя остальными, а «добавлена, но пуста» и «не
 * добавлена» неотличимы по последствиям.
 */

export type CdekFilterDim = 'status' | 'product' | 'channel';

const DIM_TITLE: Record<CdekFilterDim, string> = {
  status: 'Статусы заказов',
  product: 'Товары',
  channel: 'Каналы продаж',
};

/** Начало предложения в строке элемента: «Каналы: Ozon, Wildberries». */
const DIM_LEAD: Record<CdekFilterDim, string> = {
  status: 'Статусы',
  product: 'Товары',
  channel: 'Каналы',
};

export interface CdekFilterState {
  statuses: string[];
  products: string[];
  channels: string[];
}

export const cdekFilterDefaults = (): CdekFilterState => ({
  statuses: [...CDEK_CANON_STATUSES],
  products: [],
  channels: [],
});

/** Ось отличается от умолчания — значит действует и обязана быть видна. */
export function cdekDimActive(dim: CdekFilterDim, state: CdekFilterState): boolean {
  if (dim === 'status') return !sameCdekStatuses(state.statuses, CDEK_CANON_STATUSES);
  if (dim === 'product') return normalizeCdekProducts(state.products).length > 0;
  return normalizeCdekChannels(state.channels).length > 0;
}

function dimSummary(
  dim: CdekFilterDim,
  state: CdekFilterState,
  productOptions: readonly CdekProductOption[],
): string {
  if (dim === 'status') {
    const picked = normalizeCdekStatuses(state.statuses);
    if (picked.length === 0) return 'ничего не выбрано';
    return picked
      .map((id) => CDEK_STATUSES.find((s) => s.id === id)?.label ?? id)
      .join(', ')
      .toLocaleLowerCase('ru-RU');
  }
  if (dim === 'channel') {
    const picked = normalizeCdekChannels(state.channels);
    if (picked.length === 0) return 'все';
    return picked.map((id) => CDEK_SALES_CHANNELS.find((c) => c.id === id)?.label ?? id).join(', ');
  }
  const picked = normalizeCdekProducts(state.products);
  if (picked.length === 0) return 'все';
  if (picked.length === 1) return productOptions.find((o) => o.id === picked[0])?.name ?? picked[0];
  return `выбрано ${picked.length}`;
}

const DIMS: CdekFilterDim[] = ['status', 'product', 'channel'];

/** Значок раздела — 16px, штриховой, в цвет приглушённого текста (как у Steep). */
export const FilterGlyph = (
  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" strokeLinecap="round" />
  </svg>
);

/** Значок раздела «Сравнение». */
export const CompareGlyph = (
  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M4.5 13V3M11.5 13V3M2 5.5l2.5-2.5L7 5.5M9 10.5l2.5 2.5 2.5-2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Значок раздела «Вид» — то же семейство штриховых 16px. */
export const ViewGlyph = (
  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2.5 12.5V7M6.5 12.5V4M10.5 12.5V9M14 12.5h-13" strokeLinecap="round" />
  </svg>
);

/** «+» у правого края строки раздела: 28×28, приглушённый, без заливки. */
export function CdekFilterAdd({ dims, onAdd }: { dims: CdekFilterDim[]; onAdd: (d: CdekFilterDim) => void }) {
  if (dims.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Добавить фильтр"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-45">
        {dims.map((dim) => (
          <DropdownMenuItem key={dim} onSelect={() => onAdd(dim)}>
            {DIM_TITLE[dim]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function useCdekFilterDims(state: CdekFilterState) {
  const [opened, setOpened] = useState<CdekFilterDim[]>([]);
  const shown = useMemo(
    () => DIMS.filter((dim) => cdekDimActive(dim, state) || opened.includes(dim)),
    [state, opened],
  );
  return {
    shown,
    addable: DIMS.filter((dim) => !shown.includes(dim)),
    open: (dim: CdekFilterDim) => setOpened((prev) => (prev.includes(dim) ? prev : [...prev, dim])),
    close: (dim: CdekFilterDim) => setOpened((prev) => prev.filter((d) => d !== dim)),
  };
}

export function CdekFilterList({
  state,
  shown,
  onChange,
  onRemove,
  productOptions,
}: {
  state: CdekFilterState;
  shown: CdekFilterDim[];
  onChange: (next: CdekFilterState) => void;
  onRemove: (dim: CdekFilterDim) => void;
  productOptions: CdekProductOption[];
}) {
  const picker = (dim: CdekFilterDim): ReactNode => {
    if (dim === 'status') {
      return <CdekStatusFilter selected={state.statuses} onChange={(statuses) => onChange({ ...state, statuses })} />;
    }
    if (dim === 'channel') {
      return <CdekChannelFilter selected={state.channels} onChange={(channels) => onChange({ ...state, channels })} />;
    }
    return (
      <CdekProductFilter
        options={productOptions}
        selected={state.products}
        onChange={(products) => onChange({ ...state, products })}
      />
    );
  };

  if (shown.length === 0) {
    // Не «фильтров нет», а что именно посчитано: канон — тоже выбор, просто не сделанный руками.
    return (
      <p className="pl-[2.125rem] text-sm leading-relaxed text-muted-foreground" data-cdek-filter-rail="">
        Считается отгруженное — завершён и в доставке
      </p>
    );
  }

  return (
    <div data-cdek-filter-rail="">
      {shown.map((dim) => (
        // Элемент стоит на ОДНОЙ вертикали с названием раздела (pl-2 + ширина значка + зазор),
        // как у Steep: список читается колонкой, а не лесенкой.
        <div key={dim} className="group flex h-8 items-center gap-2 pl-[2.125rem] pr-1">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="min-w-0 flex-1 truncate rounded text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {DIM_LEAD[dim]}: <span className="text-foreground">{dimSummary(dim, state, productOptions)}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72">
              {picker(dim)}
            </PopoverContent>
          </Popover>
          <button
            type="button"
            aria-label={`Убрать фильтр: ${DIM_TITLE[dim]}`}
            onClick={() => onRemove(dim)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:opacity-100"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
