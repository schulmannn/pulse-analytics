/**
 * Разбор ошибок data-роутов СТОРОННИХ источников (МойСклад, Метрика, …): один клиентский словарь
 * вместо веток `status === 401` / `code === 'ms_token_revoked'` в каждом экране.
 *
 * Сервер сейчас отвечает на отзыв токена по-разному (401 + ms/ym_token_revoked, 409 ig_reauth), а
 * единый sendSourceError переведёт МойСклад и Метрику на 409 `source_reauth`. Экраны спрашивают
 * `sourceErrorKind` и понимают ОБЕ формы: смена формы на сервере не снимает молча «Переподключить».
 *
 * Разбор утиный (status/code/retryAfter/network), без импорта класса ApiError — как у
 * lib/authRedirect. Allow-list самого 401-редиректа (какой 401 не разлогинивает) живёт там, в
 * бут-чанке: этот словарь нужен только экранам источников и в публичный бут не попадает.
 */

/** Что случилось с источником — по нему экран выбирает состояние, а не по тексту ошибки. */
export type SourceErrorKind =
  /** Источник перестал принимать сохранённый токен: путь наружу — переподключить. */
  | 'reauth'
  /**
   * Токен жив, но владельцу токена в самом источнике не выданы права (403 МойСклада). Различается
   * ТОЛЬКО по коду (`ms_forbidden`): readApiError переносит `code`, но не `reason`. Поэтому единый
   * sendSourceError обязан отдать нехватку прав отдельным кодом (например, `source_forbidden` —
   * добавить в словарь ниже), а не 409 `source_reauth` с reason: иначе экран молча начнёт советовать
   * «Переподключить», что при живом токене не поможет.
   */
  | 'forbidden'
  /** На канале нет учётки источника: путь наружу — подключить. */
  | 'not_connected'
  /** Квота источника: повтор поможет, но не сейчас (retry_after / Retry-After). */
  | 'rate_limited'
  /** Сбой сети, сервера или самого источника: повтор может помочь. */
  | 'unavailable'
  /** Сервер отверг окно запроса (кривой или слишком широкий период). */
  | 'bad_period';

/** Машинный код сервера → состояние. Код авторитетнее статуса: статус у одной ситуации менялся. */
const KIND_BY_CODE: ReadonlyMap<string, SourceErrorKind> = new Map<string, SourceErrorKind>([
  // Нынешняя форма отзыва: 401 МойСклада и Метрики, 409 Instagram.
  ['ms_token_revoked', 'reauth'],
  ['ym_token_revoked', 'reauth'],
  ['ig_reauth', 'reauth'],
  // Будущая единая форма sendSourceError.
  ['source_reauth', 'reauth'],
  // 403 МойСклада: переподключение тем же токеном ничего не даст, нужны права сотрудника.
  ['ms_forbidden', 'forbidden'],
  ['source_not_connected', 'not_connected'],
  ['rate_limited', 'rate_limited'],
  ['source_unavailable', 'unavailable'],
  ['db_unavailable', 'unavailable'],
  ['bad_period', 'bad_period'],
]);

function field(error: object, key: string): unknown {
  return (error as Record<string, unknown>)[key];
}

/**
 * Состояние источника по ошибке его data-роута или `null`, если ошибка не про источник.
 *
 * - код сервера решает первым (обе формы отзыва → 'reauth');
 * - 401 без кода источника — `null`: это наша сессия, её уводит на /login lib/authRedirect;
 * - 404 data-роута источника — учётки на канале нет (makeResolveSourceChannel);
 * - 429 и 503 с Retry-After — квота; прочие 5xx и обрыв сети — недоступность;
 * - 400 без кода, 403 без кода (права в воркспейсе), дрейф схемы и чужие ошибки — `null`.
 */
export function sourceErrorKind(error: unknown): SourceErrorKind | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = field(error, 'code');
  const byCode = typeof code === 'string' ? KIND_BY_CODE.get(code) : undefined;
  if (byCode) return byCode;
  if (field(error, 'network') === true) return 'unavailable';
  const status = field(error, 'status');
  if (typeof status !== 'number') return null;
  if (status === 404) return 'not_connected';
  if (status === 429) return 'rate_limited';
  if (status >= 500) {
    const retryAfter = field(error, 'retryAfter');
    return status === 503 && typeof retryAfter === 'number' ? 'rate_limited' : 'unavailable';
  }
  return null;
}
