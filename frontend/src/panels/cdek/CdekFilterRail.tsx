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

/**
 * Ось, которая действует ВСЕГДА, и потому обязана быть видна всегда. Канон СДЭКа считает только
 * отгруженное (завершён + в доставке) — это не «фильтр не добавлен», это уже сделанный выбор.
 * Раньше правда о нём жила подписью «Считается отгруженное — завершён и в доставке»; владелец
 * вычеркнул её как неинформативную, и он прав: у Steep действующий фильтр показан КАРТОЧКОЙ со
 * своими значениями, а не пересказан прозой. Поэтому статусы стоят карточкой с первого кадра —
 * что посчитано, видно по пилюлям, и подпись не нужна.
 */
const ALWAYS_SHOWN: CdekFilterDim[] = ['status'];

/** Значок раздела — 16px, штриховой, в цвет приглушённого текста (как у Steep). */
export const FilterGlyph = (
  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" strokeLinecap="round" />
  </svg>
);

/**
 * Разрезы, по которым можно разложить ряд. Порядок — от самого частого вопроса к редкому.
 *
 * «Служба доставки» названа «как в выгрузке» не для красоты: это ТОТ ЖЕ столбец файла, что и
 * «Каналы продаж», только до нормализации (server/domain/cdekImport: normalizeChannel сводит
 * четыре известные службы в каналы, а всё незнакомое — в «Другую службу»). Без оговорки два
 * соседних пункта меню отвечали на один вопрос двумя разными списками; с ней видно, зачем нужен
 * второй: он показывает, что именно спрятано внутри «Другой службы».
 */
export const CDEK_BREAKDOWN_DIMS = [
  { id: 'channel', label: 'Каналам продаж' },
  { id: 'status', label: 'Статусам' },
  { id: 'product', label: 'Товарам' },
  { id: 'carrier', label: 'Службе доставки (как в выгрузке)' },
] as const;

export type CdekBreakdownDim = (typeof CDEK_BREAKDOWN_DIMS)[number]['id'];

/** Разрезы, осмысленные для ЛЮБОЙ метрики СДЭКа: у заказа ровно один канал, статус и служба. */
export const CDEK_DIMS_ALL: readonly CdekBreakdownDim[] = ['channel', 'status', 'product', 'carrier'];

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

/** Значок раздела «Цели» — концентрические круги, как у Steep (мишень). */
export const TargetGlyph = (
  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="1.75" />
  </svg>
);

/**
 * Цель метрики — тот же `prefs.target`, что задаёт «Целевой уровень» в редакторе виджета. Второго
 * механизма НЕ заводим: id виджета «Обзора» и ключ метрики совпадают (`cdek-revenue`), поэтому
 * цель, заданная здесь, доезжает до карточки сама — как и сохранённый фильтр.
 *
 * Цель — уровень НА ДЕНЬ, а не план на окно: линия рисуется в координатах ряда, а ряд у СДЭКа
 * всегда дневной (сервер отдаёт grain=day). Подпись обязана это называть, иначе человек введёт
 * сумму за месяц и получит линию далеко над данными.
 */
export function CdekTargetAdd({ onAdd }: { onAdd: () => void }) {
  return (
    <button
      type="button"
      aria-label="Добавить цель"
      onClick={onAdd}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
      </svg>
    </button>
  );
}

export function CdekTargetRow({
  value,
  onChange,
  onRemove,
  hint,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  onRemove: () => void;
  /** Строка под полем: достигнута ли цель — или почему линии сейчас нет. */
  hint?: string;
}) {
  return (
    <div className="mt-1 mb-1.5 pl-[2.125rem]">
      <div className="group flex h-7 items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          aria-label="Цель за день"
          placeholder="значение за день"
          value={value ?? ''}
          onChange={(e) => {
            const raw = e.target.value.trim();
            const num = raw === '' ? null : Number(raw);
            onChange(num != null && Number.isFinite(num) && num > 0 ? num : null);
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm tabular-nums text-foreground outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
        />
        <button
          type="button"
          aria-label="Убрать цель"
          onClick={onRemove}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:opacity-100"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

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
 *
 * Рамки у ряда НЕТ и он занимает всю ширину колонки: у Steep это `w-full justify-between` без
 * границы и без своей поверхности (замер). Рамка вокруг двух иконок читалась как отдельный
 * виджет-островок в колонке, где всё остальное разделено только волосяными линиями.
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
  const activeIndex = Math.max(0, CHART_KIND_ICONS.findIndex((k) => k.id === value));
  return (
    <div
      role="toolbar"
      aria-label="Тип графика"
      className="relative flex h-8 w-full justify-between"
      data-cdek-chart-kind=""
    >
      {/* Подсветка — ОДНА и переезжает. У Steep выбранный сегмент не перекрашивается на месте: под
          иконками едет прямоугольник (замер: `translate-x`, 250ms → наш `--motion-base` 240ms, «mode swap»). Перекраска двух фонов сообщает
          «две кнопки, одна горит», переезд — «один выбор, и вот он переместился». */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 rounded-md bg-muted transition-transform dur-base ease-house"
        style={{
          width: `${100 / CHART_KIND_ICONS.length}%`,
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />
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
              'relative inline-flex h-8 w-full items-center justify-center rounded-md transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-40',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
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
/**
 * ДОГОВОР МЕНЮ РАЗРЕЗОВ: `dims` — что метрике разрешено, `blocked` — почему остальное нельзя.
 * Запрещённый пункт ГАСНЕТ С ПРИЧИНОЙ, а не исчезает: исчезнувший пункт человек ищет глазами и
 * решает, что сломалось, — тот же канон, что у widgetCapabilities («показываем недоступное,
 * чтобы узнать почему») и у соседних контролов этой же панели (столбцы, пред. период).
 */
export function CdekSplitAdd({
  dims,
  blocked,
  onPick,
}: {
  dims: readonly CdekBreakdownDim[];
  blocked?: Partial<Record<CdekBreakdownDim, string>>;
  onPick: (dim: string) => void;
}) {
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
        {CDEK_BREAKDOWN_DIMS.map((dim) => {
          const why = dims.includes(dim.id) ? undefined : blocked?.[dim.id];
          if (!dims.includes(dim.id) && !why) return null;
          return (
            <DropdownMenuItem
              key={dim.id}
              disabled={why != null}
              onSelect={() => onPick(dim.id)}
              className={why ? 'flex-col items-start gap-0.5' : undefined}
            >
              {dim.label}
              {why && <span className="text-2xs leading-snug text-muted-foreground">{why}</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Строка выбранного разреза — СЕЛЕКТ, а не подпись с крестиком (у Steep элемент раздела выглядит
 * ровно так: `[Country ⌄] [Top 10 ⌄]` — замер живой панели). Разница не в оформлении: раньше,
 * чтобы поменять разрез, приходилось снять текущий и заново открыть «+»; теперь соседний разрез
 * выбирается на месте, одним нажатием.
 *
 * Пустое состояние МОЛЧИТ. Раньше здесь стояло «Один ряд — без разреза» — подпись, которая
 * пересказывала пустоту (владелец: «не несут инфы»). Отсутствие строки и есть отсутствие разреза.
 */
export function CdekSplitRow({
  dim,
  dims,
  blocked,
  onPick,
  onClear,
}: {
  dim: string;
  dims: readonly CdekBreakdownDim[];
  blocked?: Partial<Record<CdekBreakdownDim, string>>;
  onPick: (dim: string) => void;
  onClear: () => void;
}) {
  if (!dim) return null;
  const label = CDEK_BREAKDOWN_DIMS.find((d) => d.id === dim)?.label ?? dim;
  return (
    <div className="group mt-1 mb-1.5 flex h-7 items-center gap-2 pl-[2.125rem]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Разрез"
            className="inline-flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span className="min-w-0 truncate">{label}</span>
            <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M5.5 6.5L8 4l2.5 2.5M5.5 9.5L8 12l2.5-2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-45">
          {CDEK_BREAKDOWN_DIMS.map((d) => {
            const why = dims.includes(d.id) ? undefined : blocked?.[d.id];
            if (!dims.includes(d.id) && !why) return null;
            return (
              <DropdownMenuItem
                key={d.id}
                disabled={why != null}
                onSelect={() => onPick(d.id)}
                className={why ? 'flex-col items-start gap-0.5' : undefined}
              >
                {d.label}
                {why && <span className="text-2xs leading-snug text-muted-foreground">{why}</span>}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
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
    () =>
      DIMS.filter(
        (dim) => ALWAYS_SHOWN.includes(dim) || cdekDimActive(dim, state) || opened.includes(dim),
      ),
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
  /** Нет обработчика — нет «минуса»: ось, действующую всегда, убрать нельзя (см. ALWAYS_SHOWN). */
  onRemove?: () => void;
  picker: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const values = dimValues(dim, state, productOptions);

  // Последнее значение снять нельзя там, где пустой набор ЗНАЧИТ не «ничего», а «канон»: карточка
  // тогда показывала бы ноль пилюль, а считалось бы отгруженное — прямая ложь о числе.
  const locked = dim === 'status' && values.length <= 1;

  const dropValue = (id: string) => {
    if (dim === 'status') {
      if (locked) return;
      return onChange({ ...state, statuses: state.statuses.filter((x) => x !== id) });
    }
    if (dim === 'channel') {
      return onChange({ ...state, channels: state.channels.filter((x) => x !== id) });
    }
    onChange({ ...state, products: state.products.filter((x) => x !== id) });
  };

  return (
    <div className="mb-2 rounded-lg border border-border bg-card">
      {/* Шапка и тело, разделённые волосяной чертой — анатомия карточки фильтра Steep (замер:
          header 40px, отступ слева 16px, тело за `border-t`). Прошлая редакция была одной коробкой
          с общим padding, и название с пилюлями сливались в один ком. */}
      <header className="flex h-10 items-center gap-1.5 pr-2.5 pl-4">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded text-left text-sm font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
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
        {onRemove && (
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
        )}
      </header>

      {open ? (
        <div className="border-t border-border p-2.5">{picker}</div>
      ) : values.length > 0 ? (
        <div className="flex flex-wrap gap-1 border-t border-border px-2.5 py-2">
          {values.map((v) => (
            <span
              key={v.id}
              className={cn(
                'inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/10 pl-2 text-xs text-accent-foreground',
                // Без крестика хвост подрезается до тех же 8px, что и слева.
                locked ? 'pr-2' : 'pr-1',
              )}
            >
              <span className="truncate">{v.label}</span>
              {!locked && (
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
              )}
            </span>
          ))}
        </div>
      ) : (
        <div className="border-t border-border px-2.5 py-2">
          <p className="text-xs text-muted-foreground">Все — нажмите название, чтобы выбрать</p>
        </div>
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

  // Пустого состояния БОЛЬШЕ НЕТ: статусы стоят карточкой всегда (ALWAYS_SHOWN), а значит список
  // никогда не пуст и подпись «что посчитано» не нужна — её говорят сами пилюли.
  return (
    <div className="mt-1.5" data-cdek-filter-rail="">
      {shown.map((dim) => (
        <FilterCard
          key={dim}
          dim={dim}
          state={state}
          productOptions={productOptions}
          onChange={onChange}
          onRemove={ALWAYS_SHOWN.includes(dim) ? undefined : () => onRemove(dim)}
          picker={picker(dim)}
        />
      ))}
    </div>
  );
}
