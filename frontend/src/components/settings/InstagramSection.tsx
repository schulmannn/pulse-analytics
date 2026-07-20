import { useConnectIg, useDisconnectIg, useIgOauthStatus } from '@/api/queries';
import { fmt } from '@/lib/format';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsGroup, SettingsRow } from '@/components/settings/primitives';

/** «Instagram» — connect (OAuth) / disconnect for the selected channel, one settings row. */
export function InstagramSection() {
  const status = useIgOauthStatus();
  const connect = useConnectIg();
  const disconnect = useDisconnectIg();
  const s = status.data;
  const connectError =
    connect.error instanceof Error ? connect.error.message : null;

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
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-verdant"
              />
              Подключение Instagram
            </span>
          }
          description={
            <>
              <span className="font-medium text-foreground">
                @{s.username || s.ig_user_id}
              </span>
              {' — '}
              <span className="font-mono">
                подключён {s.connected_at ? fmt.date(s.connected_at) : '—'}
                {s.token_expires_at
                  ? ` · токен до ${fmt.date(s.token_expires_at)}`
                  : ''}
              </span>
            </>
          }
          control={
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={disconnect.isPending}
                >
                  {disconnect.isPending ? 'Отключение…' : 'Отключить'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle>Отключить Instagram?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Новые данные перестанут поступать для этого канала.
                    Подключение можно восстановить позже.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Отмена</AlertDialogCancel>
                  <AlertDialogAction asChild>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => disconnect.mutate()}
                    >
                      Отключить
                    </Button>
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
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
            <Button
              type="button"
              size="sm"
              onClick={() => connect.mutate()}
              disabled={connect.isPending || !s?.server_ready}
              className="shrink-0"
            >
              {connect.isPending
                ? 'Открываю Instagram…'
                : 'Подключить Instagram'}
            </Button>
          }
          footer={
            connectError ? (
              <p className="mt-2 text-xs font-medium text-destructive">
                {connectError}
              </p>
            ) : null
          }
        />
      )}
    </SettingsGroup>
  );
}
