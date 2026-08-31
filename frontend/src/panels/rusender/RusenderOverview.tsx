import { EmptyState } from '@/components/EmptyState';
import { useRusenderStatus } from '@/api/rusender';
import { useSelectedChannel } from '@/lib/channel-context';

/**
 * «Обзор» Rusender — пока СОСТОЯНИЕ ИСТОЧНИКА, а не витрина.
 *
 * Витрины (дневной поток открытий/кликов, лента рассылок, рост базы) собираются следующим шагом,
 * по ЖИВЫМ ответам Rusender: OpenAPI-спека сервиса уже разошлась с реальностью минимум в двух
 * местах — имена параметров пагинации в ней не описаны вовсе, а статистика A/B-рассылки в списке
 * и в get-by-id означает РАЗНЫЕ величины (агрегат по семье против собственных цифр базовой).
 * Рисовать графики по такой спеке — значит с высокой вероятностью нарисовать неправильные числа
 * и узнать об этом от владельца, а не от себя.
 *
 * Поэтому страница честно говорит, что подключение живо и сбор ещё не наполнил архив, вместо
 * пустых осей, которые читались бы как «рассылок нет».
 */
export function RusenderOverview() {
  const { channelId } = useSelectedChannel();
  const status = useRusenderStatus(channelId);

  const connected = status.data?.connected ?? false;
  const missing = status.data?.missing_scopes ?? [];

  // Разрешения могли отозвать уже ПОСЛЕ подключения — тогда источник жив, но собирать ему нечем.
  // Это отдельная беда от «не подключён», и она заслуживает отдельного текста.
  if (connected && missing.length) {
    return (
      <EmptyState
        title="Ключу не хватает разрешений"
        reason={`Rusender не отдаёт данные: у ключа нет ${missing.join(', ')}. Выдай их ключу в кабинете Rusender и подключи источник заново.`}
        action={{ to: '/connect', label: 'К подключению' }}
      />
    );
  }

  if (!connected) {
    return (
      <EmptyState
        title="Rusender не подключён"
        reason="Подключи аккаунт по API-ключу — после этого сюда приедут рассылки, открытия и размер базы."
        action={{ to: '/connect', label: 'Подключить Rusender' }}
      />
    );
  }

  return (
    <EmptyState
      title="Источник подключён, собираем данные"
      reason={
        <>
          {status.data?.account_email ? `Аккаунт ${status.data.account_email}. ` : ''}
          Первый сбор заберёт рассылки и размер базы; дневной архив открытий и кликов начинает
          копиться с момента подключения — истории у Rusender API нет, и дорисовать прошлое нечем.
        </>
      }
    />
  );
}
