import { widgetDataStateOf } from '@/lib/widgetDataState';

/** Состояние доступа к Instagram, как его отдаёт /api/ig/oauth/status. */
export type IgTokenState = 'none' | 'ok' | 'expiring' | 'expired';

/**
 * Свод состояний IG-кластера: грузимся, сломались или доступ истёк.
 *
 * Вынесено чистой функцией по той же причине, что и widgetDataStateOf: прежнее правило
 * `error = профиль упал И insights упали` было НЕДОСТИЖИМО (сервер намеренно деградирует insights
 * до пустого 200), и заметить это можно было только на проде — тестировать было нечего. Теперь
 * правило одно, и оно пришпилено тестом без React.
 *
 * Порядок состояний важен:
 * - `reauth` старше всех: доступ истёк — ждать данных, которые не придут без реконнекта, незачем,
 *   и «Повторить» тут не поможет. Это состояние продукта, а не сбой запроса;
 * - `loading` — только при известном канале: без канала запросы выключены и вечно pending, это
 *   честная пустота, а не бесконечный скелетон;
 * - `error` — упал ПРОФИЛЬ. Он обязателен: без него на экране нечего показывать. Пустые insights
 *   ошибкой не являются — за окно данных действительно может не быть.
 */
export function igAccessStateOf(input: {
  channelId: number | null;
  pending: boolean[];
  profileErrored: boolean;
  /** Машинный код с упавшего запроса профиля: 'ig_reauth' = Graph сказал «сессия истекла». */
  profileErrorCode?: string;
  /** Срок токена из статуса подключения — виден даже когда все Graph-запросы падают. */
  tokenState?: IgTokenState;
}): { loading: boolean; error: boolean; reauth: boolean } {
  const reauth = input.tokenState === 'expired' || input.profileErrorCode === 'ig_reauth';
  const { isLoading } = widgetDataStateOf({
    channelId: input.channelId,
    pending: input.pending,
    errored: [],
    fetching: [],
  });
  return {
    reauth,
    loading: !reauth && isLoading,
    error: !reauth && input.profileErrored,
  };
}
