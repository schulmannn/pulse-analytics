import { useConnectIg, useDisconnectIg, useIgOauthStatus } from '@/api/queries';
import { fmt } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';
import { BTN_DESTRUCTIVE, SettingsGroup, SettingsRow } from '@/components/settings/primitives';

/** «Instagram» — connect (OAuth) / disconnect for the selected channel, one settings row. */
export function InstagramSection() {
  const status = useIgOauthStatus();
  const connect = useConnectIg();
  const disconnect = useDisconnectIg();
  const s = status.data;
  const connectError = connect.error instanceof Error ? connect.error.message : null;

  return (
    <SettingsGroup>
      {status.isPending ? (
        <div className="py-4">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : s?.connected ? (
        <SettingsRow
          title={
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-verdant" />
              Подключение Instagram
            </span>
          }
          description={
            <>
              <span className="font-medium text-foreground">@{s.username || s.ig_user_id}</span>
              {' — '}
              <span className="font-mono">
                подключён {s.connected_at ? fmt.date(s.connected_at) : '—'}
                {s.token_expires_at ? ` · токен до ${fmt.date(s.token_expires_at)}` : ''}
              </span>
            </>
          }
          control={
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Отключить Instagram от этого канала?')) disconnect.mutate();
              }}
              disabled={disconnect.isPending}
              className={BTN_DESTRUCTIVE}
            >
              {disconnect.isPending ? 'Отключение…' : 'Отключить'}
            </button>
          }
        />
      ) : (
        <SettingsRow
          title="Подключение Instagram"
          description={
            s?.server_ready
              ? 'Подключите бизнес-аккаунт Instagram, чтобы видеть реальные охваты, аудиторию и публикации этого канала.'
              : `Подключение Instagram ещё не настроено на сервере${s?.env_fallback ? ' — сейчас показан общий аккаунт' : ''}.`
          }
          control={
            <button
              type="button"
              onClick={() => connect.mutate()}
              disabled={connect.isPending || !s?.server_ready}
              className="btn-pill shrink-0 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {connect.isPending ? 'Открываю Instagram…' : 'Подключить Instagram'}
            </button>
          }
          footer={
            connectError ? (
              <p className="mt-2 text-xs font-medium text-destructive">{connectError}</p>
            ) : null
          }
        />
      )}
    </SettingsGroup>
  );
}
