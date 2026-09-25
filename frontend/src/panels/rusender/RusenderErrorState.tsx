import { ApiError } from '@/api/client';
import { ErrorState } from '@/components/ErrorState';

/**
 * Поможет ли ручной «Повторить». 4xx — отказ по САМОМУ запросу (окно шире потолка сервера, кривая
 * дата, нет доступа, витрина не найдена): тот же запрос вернёт тот же отказ, и кнопка только
 * обещает то, чего не будет. Исключения — 408 и 429: это «не сейчас», а не «никогда». 5xx, обрыв
 * сети и прочие сбои повтор лечить может, там кнопка остаётся, как у YmOverview.
 */
export function retryCanHelp(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.network) return true;
  if (error.status === 408 || error.status === 429) return true;
  return error.status < 400 || error.status >= 500;
}

/**
 * Провал запроса витрины Rusender (Обзор, страница метрики, Рассылки, База). Причина — текст
 * сервера, как у YmOverview/MsOverview: окно шире потолка сервера (RANGE_MAX_DAYS в
 * routes/rusender.js) приходит 400-кой с подсказкой выбрать «Всё», а без reason пользователь
 * видел бы только безликое «Не удалось загрузить» и «Повторить», который ничего не меняет.
 */
export function RusenderErrorState({
  query,
}: {
  query: { error: unknown; isFetching: boolean; refetch: () => unknown };
}) {
  const { error } = query;
  return (
    <ErrorState
      reason={error instanceof Error ? error.message : 'ошибка'}
      onRetry={retryCanHelp(error) ? () => void query.refetch() : undefined}
      retrying={query.isFetching}
    />
  );
}
