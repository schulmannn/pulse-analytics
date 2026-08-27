import { toast } from 'sonner';
import type { CdekInclude } from '@/api/cdek';
import { CdekPicker } from '@/panels/cdek/CdekPicker';

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
/**
 * Порядок — от «деньги» к «не деньги». `assembled`/`confirmed` приехали с новой выгрузкой и в
 * выручку по умолчанию НЕ идут (решение владельца: канон «отгруженное = проданное», а эти два ещё
 * не отгружены). Выбрать их можно явно — тогда карточка подписывает, что именно посчитала.
 * Источник истины — server/domain/cdekImport (KNOWN_STATUSES / NON_REVENUE_STATUSES); здесь только
 * человеческие подписи, чтобы переименование витрины не требовало переигрывать импорты.
 */
export const CDEK_STATUSES = [
  { id: 'complete', label: 'Завершён' },
  { id: 'delivery', label: 'В доставке' },
  { id: 'assembled', label: 'Собран' },
  { id: 'confirmed', label: 'Подтверждён' },
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
  // Заголовок «Статусы заказов» уже занят карточкой разбивки на «Обзоре» — фильтру нужен свой
  // якорь, иначе тест «фильтра на карточке нет» ловил бы чужой текст и зеленел вхолостую.
  //
  // Снять ПОСЛЕДНИЙ статус нельзя (lockLast): пустой набор здесь не «ничего не считаем», а тихий
  // возврат к канону (см. cdekStatusInclude) — человек снимал бы значения до нуля и получал не
  // ноль заказов, а отгруженное, то есть число, которого он не выбирал.
  return (
    <CdekPicker
      mark="cdek-status-filter"
      ariaLabel="Статусы заказов"
      options={CDEK_STATUSES}
      selected={selected}
      onChange={onChange}
      lockLast
    />
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
  // Свой список с поиском и своей кнопкой раскрытия у товаров БОЛЬШЕ НЕТ: карточка фильтра уже
  // раскрывается сама, и вторая ступень раскрытия внутри неё была лишним щелчком. Поиск теперь
  // включается по длине списка, а не по оси — триста товаров и пять каналов выглядят одинаково.
  return (
    <CdekPicker
      mark="cdek-product-filter"
      ariaLabel="Товары"
      options={options.map((o) => ({ id: o.id, label: o.name }))}
      selected={selected}
      onChange={onChange}
      max={CDEK_PRODUCT_MAX}
    />
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
  return (
    <CdekPicker
      mark="cdek-channel-filter"
      ariaLabel="Каналы продаж"
      options={CDEK_SALES_CHANNELS}
      selected={selected}
      onChange={onChange}
    />
  );
}
