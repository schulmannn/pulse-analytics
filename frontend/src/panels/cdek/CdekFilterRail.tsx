import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
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

const DIMS: CdekFilterDim[] = ['status', 'product', 'channel'];

/** Значок раздела — 16px, штриховой, в цвет приглушённого текста (как у Steep). */
export const FilterGlyph = (
  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" strokeLinecap="round" />
  </svg>
);

/** Разрезы, по которым можно разложить ряд. Порядок — от самого частого вопроса к редкому. */
export const CDEK_BREAKDOWN_DIMS = [
  { id: 'channel', label: 'Каналам продаж' },
  { id: 'status', label: 'Статусам' },
  { id: 'product', label: 'Товарам' },
  { id: 'carrier', label: 'Службе доставки' },
] as const;

/**
 * Читаемый потолок числа серий. Шесть — столько же, сколько у разбивки МойСклада, и столько же
 * цветов в категориальной палитре канона (--chart-1..6, Okabe-Ito). Семёрка потребовала бы либо
 * повторить цвет, либо взять неразличимый — и то и другое врёт про идентичность серии.
 */
export const CDEK_MAX_SERIES = 6;

/** Значок раздела «Разбивка». */
export const SplitGlyph = (
  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M2 8h4l2-4 2 8 2-4h2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Значок раздела «Сравнение». */
export const CompareGlyph = (
  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M4.5 13V3M11.5 13V3M2 5.5l2.5-2.5L7 5.5M9 10.5l2.5 2.5 2.5-2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Значок раздела «Вид» — то же семейство штриховых 16px. */
export const ViewGlyph = (
  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M2.5 12.5V7M6.5 12.5V4M10.5 12.5V9M14 12.5h-13" strokeLinecap="round" />
  </svg>
);

/**
 * Тип графика — ИКОННЫМ рядом в самом верху колонки, над разделами (владелец: «возьми из Steep»).
 * У них это первое, что видишь: чем рисуем — вопрос до того, что рисуем. Текстовые пилюли внизу
 * колонки отвечали на него последними.
 */
export const CHART_KIND_ICONS: { id: 'line' | 'bar'; label: string; path: string }[] = [
  { id: 'line', label: 'Линия', path: 'M2 12l3.5-4 3 2.5L13 4' },
  { id: 'bar', label: 'Столбцы', path: 'M3 13V8M7 13V4M11 13V10M15 13H1' },
];

export function CdekChartKind({
  value,
  onChange,
  disabled,
}: {
  value: 'line' | 'bar';
  onChange: (v: 'line' | 'bar') => void;
  /** Типы, недоступные при текущем состоянии: гаснут, а не бездействуют молча. Под разбивкой это
   *  столбцы — несколько рядов столбцами за окно нечитаемы. */
  disabled?: ReadonlyArray<'line' | 'bar'>;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Тип графика"
      className="flex items-center gap-0.5 rounded-lg border border-border p-1"
      data-cdek-chart-kind=""
    >
      {CHART_KIND_ICONS.map((kind) => {
        const active = value === kind.id;
        const off = disabled?.includes(kind.id) ?? false;
        return (
          <button
            key={kind.id}
            type="button"
            aria-pressed={active}
            aria-label={kind.label}
            title={kind.label}
            disabled={off}
            onClick={() => onChange(kind.id)}
            className={cn(
              'inline-flex h-8 flex-1 items-center justify-center rounded-md transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-40',
              active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d={kind.path} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        );
      })}
    </div>
  );
}

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

/** Выбор разреза — тем же приёмом, что и фильтры: «+» в строке раздела, выбранное строкой ниже. */
export function CdekSplitAdd({ onPick }: { onPick: (dim: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Выбрать разрез"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-45">
        {CDEK_BREAKDOWN_DIMS.map((dim) => (
          <DropdownMenuItem key={dim.id} onSelect={() => onPick(dim.id)}>
            {dim.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Строка выбранного разреза — та же вертикаль и тот же крестик, что у строки фильтра. */
export function CdekSplitRow({ dim, onClear }: { dim: string; onClear: () => void }) {
  const label = CDEK_BREAKDOWN_DIMS.find((d) => d.id === dim)?.label ?? dim;
  if (!dim) {
    return (
      <p className="pl-[2.125rem] text-sm leading-relaxed text-muted-foreground">
        Один ряд — без разреза
      </p>
    );
  }
  return (
    <div className="group flex h-8 items-center gap-2 pl-[2.125rem] pr-1">
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        По: <span className="text-foreground">{label.toLocaleLowerCase('ru-RU')}</span>
      </span>
      <button
        type="button"
        aria-label="Убрать разбивку"
        onClick={onClear}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:opacity-100"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
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
/** Значения выбранной оси — по одной пилюле, каждая снимается сама. */
function dimValues(
  dim: CdekFilterDim,
  state: CdekFilterState,
  productOptions: readonly CdekProductOption[],
): { id: string; label: string }[] {
  if (dim === 'status') {
    return normalizeCdekStatuses(state.statuses).map((id) => ({
      id,
      label: CDEK_STATUSES.find((x) => x.id === id)?.label ?? id,
    }));
  }
  if (dim === 'channel') {
    return normalizeCdekChannels(state.channels).map((id) => ({
      id,
      label: CDEK_SALES_CHANNELS.find((x) => x.id === id)?.label ?? id,
    }));
  }
  return normalizeCdekProducts(state.products).map((id) => ({
    id,
    label: productOptions.find((o) => o.id === id)?.name ?? id,
  }));
}

/**
 * Карточка добавленного фильтра. Анатомия снята ЗАМЕРОМ со Steep (владелец вошёл и дал посмотреть):
 * своя поверхность на ступень выше панели, волосяная рамка 0.8px, скругление, 8px до следующей;
 * название обычного размера ОСНОВНЫМ цветом с треугольником раскрытия; выбранные значения —
 * ПИЛЮЛЯМИ, у каждой свой крестик.
 *
 * Прошлая редакция печатала значения строкой через запятую и давала один крестик на всю ось: чтобы
 * убрать один канал из трёх, приходилось лезть в выбор. Пилюля снимается на месте — это не только
 * вид, это другая механика.
 *
 * Выбор раскрывается ВНУТРИ карточки, а не в поповере: у Steep так (в развёрнутой карточке живут
 * поиск и список значений), и в 300px колонке это честнее — поповер поверх узкой панели закрывает
 * соседние фильтры, ради которых его и открывают.
 */
function FilterCard({
  dim,
  state,
  productOptions,
  onChange,
  onRemove,
  picker,
}: {
  dim: CdekFilterDim;
  state: CdekFilterState;
  productOptions: CdekProductOption[];
  onChange: (next: CdekFilterState) => void;
  onRemove: () => void;
  picker: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const values = dimValues(dim, state, productOptions);

  const dropValue = (id: string) => {
    if (dim === 'status') {
      return onChange({ ...state, statuses: state.statuses.filter((x) => x !== id) });
    }
    if (dim === 'channel') {
      return onChange({ ...state, channels: state.channels.filter((x) => x !== id) });
    }
    onChange({ ...state, products: state.products.filter((x) => x !== id) });
  };

  return (
    <div className="mb-2 rounded-lg border border-border bg-card p-2.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left text-sm font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <svg
            viewBox="0 0 16 16"
            className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden="true"
          >
            <path d="M6 3.5l5 4.5-5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="truncate">{DIM_TITLE[dim]}</span>
        </button>
        <button
          type="button"
          aria-label={`Убрать фильтр: ${DIM_TITLE[dim]}`}
          onClick={onRemove}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {open ? (
        <div className="mt-2.5">{picker}</div>
      ) : values.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v.id}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2 pr-1 text-xs text-accent-foreground"
            >
              <span className="truncate">{v.label}</span>
              <button
                type="button"
                aria-label={`Убрать: ${v.label}`}
                onClick={() => dropValue(v.id)}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-primary/15 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">Все — нажмите название, чтобы выбрать</p>
      )}
    </div>
  );
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
        <FilterCard
          key={dim}
          dim={dim}
          state={state}
          productOptions={productOptions}
          onChange={onChange}
          onRemove={() => onRemove(dim)}
          picker={picker(dim)}
        />
      ))}
    </div>
  );
}
