import { useMemo, useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
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
 * Раздел «Фильтры» правой колонки — по образцу метрик Steep (владелец принёс скриншот).
 *
 * ГЛАВНОЕ УСТРОЙСТВО: фильтр не нарисован, пока его не добавили. Раньше колонка держала все оси
 * развёрнутыми — одиннадцать чипов на экране всегда, даже когда ничто не отфильтровано, — и каждый
 * новый статус или канал отвоёвывал себе место. С приездом английской выгрузки статусов стало
 * шесть, и владелец справедливо спросил, куда мы денем ещё четыре чипа. Ответ: никуда, их там не
 * будет, пока человек сам не откроет ось.
 *
 * ПУСТОЕ СОСТОЯНИЕ НЕ МОЛЧИТ. У Steep «фильтр не добавлен» значит «не фильтруем», у нас — нет:
 * канон исключает отмены, возвраты, собранные и подтверждённые. Пустая колонка читалась бы как
 * «считается всё», поэтому вместо одиннадцати чипов там стоит одна строка о том, что посчитано.
 *
 * «ДОБАВЛЕННОСТЬ» НЕ ХРАНИТСЯ ОТДЕЛЬНО. Ось показана, если её выбор отличается от умолчания, плюс
 * то, что человек открыл в этой сессии. Иначе пришлось бы держать четвёртый ключ, который умеет
 * разойтись с тремя остальными: «ось добавлена, но пуста» и «ось не добавлена» неотличимы по
 * последствиям, а значит хранить это состояние незачем.
 */

export type CdekFilterDim = 'status' | 'product' | 'channel';

const DIM_TITLE: Record<CdekFilterDim, string> = {
  status: 'Статусы заказов',
  product: 'Товары',
  channel: 'Каналы продаж',
};

/** Короткое имя оси в строке фильтра — не заголовок, а начало предложения «Статусы: …». */
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

/** Умолчание оси: то, что действует, пока фильтр не тронут. */
export const cdekFilterDefaults = (): CdekFilterState => ({
  statuses: [...CDEK_CANON_STATUSES],
  products: [],
  channels: [],
});

/** Ось отличается от умолчания — значит она действует и обязана быть видна на экране. */
export function cdekDimActive(dim: CdekFilterDim, state: CdekFilterState): boolean {
  if (dim === 'status') return !sameCdekStatuses(state.statuses, CDEK_CANON_STATUSES);
  if (dim === 'product') return normalizeCdekProducts(state.products).length > 0;
  return normalizeCdekChannels(state.channels).length > 0;
}

/** Значение оси человеческими словами — правая половина строки «Статусы: завершён, в доставке». */
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
  if (picked.length === 1) {
    return productOptions.find((o) => o.id === picked[0])?.name ?? picked[0];
  }
  return `выбрано ${picked.length}`;
}

const DIMS: CdekFilterDim[] = ['status', 'product', 'channel'];

export function CdekFilterRail({
  state,
  onChange,
  productOptions,
}: {
  state: CdekFilterState;
  onChange: (next: CdekFilterState) => void;
  productOptions: CdekProductOption[];
}) {
  // Оси, открытые в этой сессии. Действующие видны и без неё — см. комментарий модуля.
  const [opened, setOpened] = useState<CdekFilterDim[]>([]);
  const shown = useMemo(
    () => DIMS.filter((dim) => cdekDimActive(dim, state) || opened.includes(dim)),
    [state, opened],
  );
  const addable = DIMS.filter((dim) => !shown.includes(dim));

  const reset = (dim: CdekFilterDim) => {
    const defaults = cdekFilterDefaults();
    setOpened((prev) => prev.filter((d) => d !== dim));
    if (dim === 'status') return onChange({ ...state, statuses: defaults.statuses });
    if (dim === 'product') return onChange({ ...state, products: defaults.products });
    return onChange({ ...state, channels: defaults.channels });
  };

  const picker = (dim: CdekFilterDim): ReactNode => {
    if (dim === 'status') {
      return (
        <CdekStatusFilter
          selected={state.statuses}
          onChange={(statuses) => onChange({ ...state, statuses })}
        />
      );
    }
    if (dim === 'channel') {
      return (
        <CdekChannelFilter
          selected={state.channels}
          onChange={(channels) => onChange({ ...state, channels })}
        />
      );
    }
    return (
      <CdekProductFilter
        options={productOptions}
        selected={state.products}
        onChange={(products) => onChange({ ...state, products })}
      />
    );
  };

  return (
    <div data-cdek-filter-rail="">
      {shown.length === 0 ? (
        // Не «фильтров нет», а что именно посчитано: канон — тоже выбор, просто не сделанный руками.
        <p className="text-xs leading-relaxed text-muted-foreground">
          Считается отгруженное — завершён и в доставке
        </p>
      ) : (
        <div className="-my-1.5">
          {shown.map((dim) => (
            <div key={dim} className="flex items-center gap-2 border-border py-1.5 [&+&]:border-t">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded text-left text-xs leading-relaxed text-foreground transition-colors hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    {DIM_LEAD[dim]}:{' '}
                    <span className="text-primary">{dimSummary(dim, state, productOptions)}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72">
                  {picker(dim)}
                </PopoverContent>
              </Popover>
              <button
                type="button"
                aria-label={`Убрать фильтр: ${DIM_TITLE[dim]}`}
                onClick={() => reset(dim)}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {addable.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'mt-2 inline-flex items-center gap-1.5 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40',
              )}
            >
              <span aria-hidden="true" className="text-sm leading-none">
                +
              </span>
              Добавить фильтр
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {addable.map((dim) => (
              <DropdownMenuItem
                key={dim}
                onSelect={() => setOpened((prev) => (prev.includes(dim) ? prev : [...prev, dim]))}
              >
                {DIM_TITLE[dim]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
