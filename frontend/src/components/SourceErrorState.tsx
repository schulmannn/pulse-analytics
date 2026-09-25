import type { ComponentProps } from 'react';
import { sourceErrorKind } from '@/api/sourceErrors';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';

type AccessCopy = {
  title: string;
  /** Страничное состояние (Обзор, страница метрики) — путь наружу целиком. */
  reason: string;
  /** Состояние внутри карточки и виджета Главной — коротко, тайл режет описание до двух строк. */
  compactReason: string;
  /** Кнопка наружу; её нет, если чинится не у нас. */
  action?: { to: string; label: string; compactLabel: string };
};

/**
 * Тексты доступа МойСклада и Метрики. Страничные — те, что Обзоры показывали и раньше.
 *
 * МойСклад: замены токена у подключённого источника на /connect нет (только «Отключить»), поэтому
 * путь назван целиком; DELETE /api/ms/account сносит только учётку, архив ms_daily остаётся.
 * 403 (`ms_forbidden`) — токен жив, но сотруднику не выданы права: переподключение тем же токеном
 * ничего не даст, поэтому кнопки нет — права проверяются МойСкладом на каждом запросе, после их
 * выдачи хватает обновить страницу.
 */
const ACCESS_COPY: Record<'ms' | 'ym', Partial<Record<'reauth' | 'forbidden', AccessCopy>>> = {
  ms: {
    reauth: {
      title: 'Токен МойСклада отозван',
      reason:
        'Источник перестал принимать наш токен — создайте новый в МойСкладе, затем на странице подключений отключите старый и вставьте новый. История продаж сохранится.',
      compactReason: 'МойСклад перестал принимать наш токен — переподключите источник.',
      action: { to: '/connect?source=moysklad', label: 'Переподключить МойСклад', compactLabel: 'Переподключить' },
    },
    forbidden: {
      title: 'Не хватает прав в МойСкладе',
      reason:
        'МойСклад не отдаёт показатели продаж и заказов сотруднику, чей токен подключён. Для дашборда ему нужен просмотр «Показателей», «Заказов покупателей», «Возвратов покупателей», «Контрагентов», «Каналов продаж», отчётов «Прибыльность» и «Остатки», а также право видеть себестоимость и прибыль. Выдайте права в карточке сотрудника в МойСкладе и обновите страницу — переподключать токен не нужно.',
      compactReason: 'Выдайте сотруднику, чей токен подключён, права на эти данные в МойСкладе и обновите страницу.',
    },
  },
  ym: {
    reauth: {
      title: 'Токен Яндекса отозван',
      reason: 'Счётчик перестал принимать наш токен — выпустите новый OAuth-токен и переподключите.',
      compactReason: 'Счётчик перестал принимать наш токен — переподключите Метрику.',
      action: { to: '/connect?source=metrika', label: 'Переподключить Метрику', compactLabel: 'Переподключить' },
    },
  },
};

type SourceErrorStateProps = ComponentProps<typeof ErrorState> & {
  source: 'ms' | 'ym';
  /** Ошибка упавшего запроса data-роута этого источника — её разбирает sourceErrorKind. */
  error: unknown;
};

/**
 * Провал запроса МойСклада/Метрики. Отзыв токена (обе формы: нынешний 401 с кодом и будущий
 * 409 `source_reauth`) и нехватка прав — не «сбой, попробуйте ещё раз», а состояние доступа:
 * вместо «Повторить», который вернёт тот же отказ, — причина и путь наружу. Раскладка та же:
 * `compact`/`size`/`className` переходят в EmptyState, резерв высоты у них общий. Любая другая
 * ошибка — прежний ErrorState со всеми переданными пропсами.
 */
export function SourceErrorState({ source, error, ...errorProps }: SourceErrorStateProps) {
  const kind = sourceErrorKind(error);
  const copy = kind === 'reauth' || kind === 'forbidden' ? ACCESS_COPY[source][kind] : undefined;
  if (!copy) return <ErrorState {...errorProps} />;
  const { compact, size, className } = errorProps;
  return (
    <EmptyState
      compact={compact}
      size={size}
      className={className}
      title={copy.title}
      reason={compact ? copy.compactReason : copy.reason}
      action={copy.action ? { to: copy.action.to, label: compact ? copy.action.compactLabel : copy.action.label } : undefined}
    />
  );
}
