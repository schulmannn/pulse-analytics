import type { WidgetResult } from '@/lib/resolveWidgetMetric';

/**
 * Что возвращает любой widget-data хук (TG / IG / МойСклад / Метрика). Общий тип держит все четыре
 * источника на одном контракте состояний, чтобы «ошибка ≠ пустота» нельзя было починить в одном
 * месте и забыть в трёх остальных.
 *
 * Пустота — это `result.empty`, то есть достоверный ответ «за это окно данных нет». Молчание
 * упавшего запроса пустотой не является и обязано приходить сюда как `isError`.
 */
export interface WidgetDataState {
  result: WidgetResult;
  isLoading: boolean;
  /** Запрос упал. Карточка обязана показать ошибку с повтором, а НЕ «Нет данных за период». */
  isError: boolean;
  /** Повтор уже в полёте — кнопка «Повторить» гасится и говорит «Загрузка…». */
  isRetrying: boolean;
  retry: () => void;
}

/**
 * Свод состояний нескольких запросов карточки в одно. Вынесено из хуков чистой функцией по двум
 * причинам: у четырёх источников правило обязано быть буквально одним и тем же, и его надо
 * гейтить тестом без React.
 *
 * Правила:
 * - без канала запросы отключены и вечно `pending` — это НЕ загрузка (иначе вечный скелетон) и не
 *   сбой, а честная пустота;
 * - `isError` гейтится по `!isLoading`, поэтому состояния взаимоисключающие: карточка не может
 *   одновременно грузиться и показывать сбой (важно для повтора — во время refetch снова pending);
 * - падение ЛЮБОГО из обязательных источников — сбой всей карточки: показать половину данных под
 *   заголовком, который обещает целое, хуже честной ошибки.
 */
export function widgetDataStateOf(input: {
  channelId: number | null;
  pending: boolean[];
  errored: boolean[];
  fetching: boolean[];
}): { isLoading: boolean; isError: boolean; isRetrying: boolean } {
  const isLoading = input.channelId != null && input.pending.some(Boolean);
  const isError = !isLoading && input.errored.some(Boolean);
  return { isLoading, isError, isRetrying: input.fetching.some(Boolean) };
}
