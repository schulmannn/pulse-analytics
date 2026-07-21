import { useState, type FormEvent } from 'react';
import { ErrorState } from '@/components/ErrorState';
import { Link } from 'react-router-dom';
import {
  useChannelKeys,
  useChannels,
  useCreateChannel,
  useCreateKey,
  useDeleteChannel,
  useMe,
  useRevokeKey,
} from '@/api/queries';
import { ApiError } from '@/api/client';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ChannelAvatar } from '@/components/ChannelAvatar';
import { EmptyState } from '@/components/EmptyState';
import { SourceStatus } from '@/components/SourceStatus';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BTN_DESTRUCTIVE,
  SettingsGroup,
  SettingsIcon,
} from '@/components/settings/primitives';

/** «Каналы» — add a Telegram channel + the connected list with collector API keys. */
export function ChannelsSection() {
  const { data, isLoading, isError, error, refetch } = useChannels();
  const me = useMe();
  // UID/Owner are internal identifiers — admin debugging info, not product language.
  const isSuperuser = me.data?.role === 'superuser';
  const createChannelMutation = useCreateChannel();
  const deleteChannelMutation = useDeleteChannel();

  const [usernameInput, setUsernameInput] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeChannelKeysId, setActiveChannelKeysId] = useState<number | null>(null);

  if (isLoading) return <ChannelsSkeleton />;
  if (isError) {
    return (
      <ErrorState
        title="Не удалось загрузить настройки каналов"
        reason={error instanceof Error ? error.message : 'ошибка сервера'}
        onRetry={() => refetch()}
      />
    );
  }

  if (data?.enabled === false) {
    return (
      <EmptyState
        title="БД не подключена"
        reason="Управление каналами и токенами недоступно."
      />
    );
  }

  const channels = data?.channels ?? [];

  const handleAddChannel = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    let cleanUsername = usernameInput.trim();
    if (cleanUsername.startsWith('@')) cleanUsername = cleanUsername.substring(1);
    if (!cleanUsername) return;
    try {
      await createChannelMutation.mutateAsync({ username: cleanUsername });
      setUsernameInput('');
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : 'Не удалось добавить канал');
    }
  };

  const handleDeleteChannel = (id: number, title: string) => {
    if (window.confirm(`Удалить канал "${title}" из мониторинга? Это необратимо.`)) {
      if (activeChannelKeysId === id) setActiveChannelKeysId(null);
      deleteChannelMutation.mutate(id);
    }
  };

  return (
    <>
      <SettingsGroup title="Добавить канал">
        <div className="py-4">
          <div className="text-sm font-medium text-foreground">Telegram-канал</div>
          <p className="mt-0.5 max-w-[56ch] text-xs leading-relaxed text-ink3">
            Укажите @username публичного канала — начнём собирать статистику.
          </p>
          <form onSubmit={handleAddChannel} className="mt-3 flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <span className="absolute left-3 top-2.5 select-none font-mono text-sm text-muted-foreground">@</span>
              <input
                type="text"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                placeholder="channel_username"
                aria-label="Username Telegram-канала"
                aria-invalid={errorMessage ? true : undefined}
                aria-describedby={errorMessage ? 'add-channel-err' : undefined}
                disabled={createChannelMutation.isPending}
                className="w-full rounded border bg-background py-2 pl-7 pr-3 font-mono text-sm focus:outline-hidden focus:ring-1 focus:ring-primary"
              />
            </div>
            <button
              type="submit"
              disabled={createChannelMutation.isPending || !usernameInput.trim()}
              className="btn-pill shrink-0 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {createChannelMutation.isPending ? 'Добавление…' : 'Подключить'}
            </button>
          </form>
          {errorMessage && <p role="alert" id="add-channel-err" className="mt-2.5 text-xs font-medium text-destructive">{errorMessage}</p>}
        </div>
      </SettingsGroup>

      {channels.length === 0 ? (
        <SettingsGroup title="Подключённые каналы">
          <div className="py-4">
            <EmptyState title="Список каналов пуст" reason="Добавьте первый канал выше." />
          </div>
        </SettingsGroup>
      ) : (
        <SettingsGroup title="Подключённые каналы">
          {channels.map((channel) => {
            const isCentral = channel.source === 'central' || channel.status === 'central';
            const displayTitle = channel.title || channel.username || `ID: ${channel.id}`;
            const initial = (channel.username || channel.title || 'T').slice(0, 1).toUpperCase();
            const keysOpen = activeChannelKeysId === channel.id && !isCentral;
            return (
              <div key={channel.id} className="py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                  <div className="flex min-w-0 items-start gap-3">
                    <ChannelAvatar
                      source={channel.source}
                      initial={initial}
                      className="h-9 w-9 rounded text-sm"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-sm font-medium text-foreground">{displayTitle}</span>
                        {channel.username && (
                          <span className="font-mono text-xs text-muted-foreground">@{channel.username}</span>
                        )}
                        {isCentral && (
                          <span className="inline-flex select-none items-center rounded bg-primary/10 px-2 py-0.5 text-2xs font-medium tracking-wide text-primary">
                            central
                          </span>
                        )}
                      </div>
                      {isSuperuser && (
                        <div className="font-mono text-2xs text-muted-foreground">
                          UID: {channel.id}
                          {channel.owner_uid ? ` · Owner: ${channel.owner_uid}` : ''}
                        </div>
                      )}
                      <div className="mt-0.5 text-xs">
                        <SourceStatus channelId={channel.id} source={channel.source} />
                      </div>
                    </div>
                  </div>
                  {!isCentral && (
                    <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                      <button
                        type="button"
                        onClick={() =>
                          setActiveChannelKeysId(activeChannelKeysId === channel.id ? null : channel.id)
                        }
                        className={cn(
                          'btn-pill border px-3.5 py-1.5 text-xs font-medium transition-colors',
                          activeChannelKeysId === channel.id
                            ? 'border-border bg-secondary text-foreground'
                            : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        API-ключи
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteChannel(channel.id, displayTitle)}
                        disabled={deleteChannelMutation.isPending}
                        aria-label={`Удалить канал ${displayTitle}`}
                        className={cn(BTN_DESTRUCTIVE, 'px-2.5')}
                      >
                        <SettingsIcon name="close" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
                {keysOpen && (
                  <div className="mt-3.5 border-t border-border pt-3.5">
                    <ChannelKeysPanel channelId={channel.id} />
                  </div>
                )}
              </div>
            );
          })}
        </SettingsGroup>
      )}
    </>
  );
}

function ChannelKeysPanel({ channelId }: { channelId: number }) {
  const { data, isLoading, isError, refetch } = useChannelKeys(channelId);
  const createKeyMutation = useCreateKey(channelId);
  const [keyError, setKeyError] = useState<string | null>(null);
  const revokeKeyMutation = useRevokeKey(channelId);

  const [oneTimeKey, setOneTimeKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (isError) return <ErrorState className="py-4" title="Не удалось загрузить ключи" onRetry={() => refetch()} />;

  const keys = data?.keys ?? [];

  const handleCreateKey = async () => {
    setOneTimeKey(null);
    setCopied(false);
    setKeyError(null);
    try {
      const res = await createKeyMutation.mutateAsync({ label: 'локальный коллектор' });
      if (res.key) setOneTimeKey(res.key);
    } catch {
      // Inline вместо browser-alert (аудит) — тот же паттерн, что ошибка загрузки ключей выше.
      setKeyError('Не удалось сгенерировать токен — попробуйте ещё раз');
    }
  };

  const handleCopy = (txt: string) => {
    navigator.clipboard.writeText(txt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const ingestUrl = `${window.location.origin}/api/collector/ingest`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h4 className="text-xs font-medium tracking-wider text-muted-foreground">Ключи внешних коллекторов</h4>
          <Link
            to="/connect"
            className="text-2xs text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            Что делать с ключом? →
          </Link>
        </div>
        <button
          type="button"
          onClick={handleCreateKey}
          disabled={createKeyMutation.isPending}
          className="rounded bg-primary px-2.5 py-1 text-2xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {createKeyMutation.isPending ? 'Генерация…' : 'Создать ключ'}
        </button>
      </div>
      {keyError && <p role="alert" className="text-xs text-destructive">{keyError}</p>}

      {/* role="status" on the inserted box itself (announced on insertion) — a permanently mounted
          live-region wrapper would eat two space-y-4 gaps in the default no-token state. */}
      {oneTimeKey && (
          <div role="status" className="space-y-2.5 rounded border border-status-warn/40 bg-background p-3.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-status-warn">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              >
                <path
                  d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M12 9v4M12 17h.01" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Скопируйте токен сейчас — он показывается ОДИН раз:</span>
            </div>
            <div className="relative flex items-center gap-2 break-all rounded bg-muted/60 p-2 font-mono text-xs text-foreground">
              <span className="flex-1 select-all pr-16">{oneTimeKey}</span>
              <button
                type="button"
                onClick={() => handleCopy(oneTimeKey)}
                className="absolute right-2 top-1.5 rounded border bg-background px-2 py-1 font-sans text-2xs font-medium transition-colors hover:bg-secondary"
              >
                {copied ? 'Скопировано' : 'Копировать'}
              </button>
              <span role="status" className="sr-only">{copied ? 'Скопировано' : ''}</span>
            </div>
            <div className="text-2xs leading-normal text-muted-foreground">
              Ingest URL: <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{ingestUrl}</code>
            </div>
          </div>
      )}

      {keys.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">Активных ключей для канала нет.</p>
      ) : (
        <div className="space-y-1.5">
          {keys.map((k) => (
            <div
              key={k.id}
              className={cn(
                'flex items-center justify-between rounded border border-border/40 bg-background p-2 font-mono text-xs',
                k.revoked && 'opacity-50',
              )}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span className="font-medium text-foreground">{k.key_prefix}…</span>
                <span className="font-sans text-2xs text-muted-foreground">[{k.label || 'коллектор'}]</span>
                {k.last_used_at && (
                  <span className="font-sans text-2xs text-muted-foreground">
                    использован: {fmt.date(k.last_used_at)}
                  </span>
                )}
              </div>
              <div>
                {k.revoked ? (
                  <span className="font-sans text-2xs italic text-muted-foreground">отозван</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm('Отозвать ключ? Коллектор потеряет доступ.')) revokeKeyMutation.mutate(k.id);
                    }}
                    disabled={revokeKeyMutation.isPending}
                    className="font-sans text-2xs text-destructive hover:underline disabled:opacity-50"
                  >
                    Отозвать
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelsSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <div className="rounded border border-border p-4">
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-4 w-48" />
        <div className="divide-y divide-border rounded border border-border">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="p-4">
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
