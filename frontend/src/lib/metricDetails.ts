// Второй слой каталога метрик — детали источника (U05). Лёгкий индекс (lib/metricIndex.ts) живёт
// в общем чанке и не содержит текстов; всё тяжёлое лежит рядом с источником и грузится лениво:
//   - info           — тексты ⓘ (подпись, «как считается», «что входит», «откуда число»);
//   - explorerSchema — URL-схема контролов полного разбора (что пишется в URL и что пока живёт
//                      в локальном состоянии страницы);
//   - deps           — запросы (хуки api/*), данные которых метрика читает на каждой поверхности.
//
// Детали записаны по текущему коду: потребители их пока не читают. Каталог виджетов
// (widgetMetrics.ts) по-прежнему берёт тексты синхронно — из тех же модулей *MetricInfo.ts.
// Тексты ⓘ есть пока только у метрик виджетов: подписи разборов /metrics/* без виджета (СДЭК,
// Rusender, упоминания, кампании, DAILY_DEFS IgMetricPage) переедут сюда с переводом страниц.
//
// Цена первого потребителя: пока loadMetricDetails никто не вызывает, этот модуль в сборку не
// попадает. Статический импорт его в оболочку добавит ей около 1.6 KB gzip сверх индекса (сам
// загрузчик и preload-карты восьми import(), замер ревью 1.4) — этот рост объясняет PR потребителя.

import type { MetricId, MetricIndexSource } from '@/lib/metricIndex';

/** Тексты ⓘ метрики. `label` — имя карточки; `glossaryLabel` — длинное имя в подсказке. */
export interface MetricInfo {
  label: string;
  glossaryLabel?: string;
  /** Как считается, словами. */
  formula?: string;
  /** Что входит / уточнение. */
  included?: string;
  /** Откуда число. */
  sourceNote?: string;
}

/** Параметр URL разбора. */
export interface ExplorerUrlParam {
  /** Допустимые значения; нет — свободное значение (id канала, источника, кампании). */
  values?: readonly string[];
  /** Значение по умолчанию (в URL не пишется); null — нет значения или оно зависит от данных. */
  defaultValue: string | null;
}

/** Контролы полного разбора. Окно (p/from/to) сюда не входит: у разбора с
 *  capabilities.window === 'explorer' им владеет PeriodUrlSync. */
export interface MetricExplorerSchema {
  url: Readonly<Record<string, ExplorerUrlParam>>;
  /** Контролы, которые сегодня живут в состоянии страницы и теряются при reload (SHELL-4). */
  local: readonly string[];
}

/** Хуки api/*, чьи данные читает метрика: на Главной (виджет) и в полном разборе. */
export interface MetricDeps {
  widget?: readonly string[];
  explorer?: readonly string[];
}

export interface MetricDetails {
  info: Readonly<Record<MetricId, MetricInfo>>;
  explorerSchema: Readonly<Record<MetricId, MetricExplorerSchema>>;
  deps: Readonly<Record<MetricId, MetricDeps>>;
}

type DetailsModule = { details: MetricDetails };

/** Каждый источник — свои чанки: `import()` не тянет детали в общий чанк (гейт check-bundle-size). */
const LOADERS: Record<MetricIndexSource, () => Promise<DetailsModule[]>> = {
  tg: () => Promise.all([import('@/panels/tgMetricDetails'), import('@/panels/mentions/mentionsMetricDetails')]),
  ig: () => Promise.all([import('@/panels/igMetricDetails')]),
  ms: () => Promise.all([import('@/panels/sklad/msMetricDetails')]),
  ym: () => Promise.all([import('@/panels/metrika/ymMetricDetails')]),
  cdek: () => Promise.all([import('@/panels/cdek/cdekMetricDetails')]),
  rusender: () => Promise.all([import('@/panels/rusender/rusenderMetricDetails')]),
  multi: () => Promise.all([import('@/panels/campaign/campaignMetricDetails')]),
};

export function mergeMetricDetails(parts: readonly MetricDetails[]): MetricDetails {
  return {
    info: Object.assign({}, ...parts.map((part) => part.info)),
    explorerSchema: Object.assign({}, ...parts.map((part) => part.explorerSchema)),
    deps: Object.assign({}, ...parts.map((part) => part.deps)),
  };
}

const cache = new Map<MetricIndexSource, Promise<MetricDetails>>();

/** Детали всех метрик источника. Промис кешируется; неудачная загрузка (сеть, деплой) из кеша
 *  выбрасывается, чтобы следующий вызов попробовал снова. */
export function loadMetricDetails(source: MetricIndexSource): Promise<MetricDetails> {
  const hit = cache.get(source);
  if (hit) return hit;
  const pending = LOADERS[source]().then((modules) => mergeMetricDetails(modules.map((module) => module.details)));
  cache.set(source, pending);
  pending.catch(() => cache.delete(source));
  return pending;
}
