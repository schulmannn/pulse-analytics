import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  useChannels,
  useCreateChannel,
  useDeleteChannel,
  useChannelKeys,
  useCreateKey,
  useRevokeKey,
} from '@/api/queries';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmt } from '@/lib/format';
import { ApiError } from '@/api/client';
import { Skeleton } from '@/components/ui/skeleton';

export function Settings() {
  const { data, isLoading, isError, error } = useChannels();
  const createChannelMutation = useCreateChannel();
  const deleteChannelMutation = useDeleteChannel();

  const [usernameInput, setUsernameInput] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeChannelKeysId, setActiveChannelKeysId] = useState<number | null>(null);

  if (isLoading) return <SettingsSkeleton />;
  if (isError) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Ошибка загрузки настроек: {error instanceof Error ? error.message : 'ошибка сервера'}
        </CardContent>
      </Card>
    );
  }

  if (data?.enabled === false) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          БД не подключена. Управление каналами и токенами недоступно.
        </CardContent>
      </Card>
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
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Настройки сбора</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Подключённые Telegram-каналы и токены внешних коллекторов
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Добавить канал</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAddChannel} className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <span className="absolute left-3 top-2.5 select-none font-mono text-sm text-muted-foreground">@</span>
              <input
                type="text"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                placeholder="channel_username"
                disabled={createChannelMutation.isPending}
                className="w-full rounded-md border bg-background py-2 pl-7 pr-3 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <button
              type="submit"
              disabled={createChannelMutation.isPending || !usernameInput.trim()}
              className="shrink-0 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {createChannelMutation.isPending ? 'Добавление…' : 'Подключить'}
            </button>
          </form>
          {errorMessage && <p className="mt-2.5 text-xs font-medium text-destructive">{errorMessage}</p>}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h3 className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Подключённые каналы</h3>
        {channels.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/20 py-6 text-center text-sm text-muted-foreground">
            Список каналов пуст.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {channels.map((channel) => {
              const isCentral = channel.source === 'central' || channel.status === 'central';
              const displayTitle = channel.title || channel.username || `ID: ${channel.id}`;
              return (
                <Card key={channel.id} className={isCentral ? 'border-primary/30' : undefined}>
                  <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{displayTitle}</span>
                        {channel.username && <span className="font-mono text-xs text-muted-foreground">@{channel.username}</span>}
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        UID: {channel.id}
                        {channel.owner_uid ? ` · Owner: ${channel.owner_uid}` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                      {isCentral ? (
                        <span className="inline-flex select-none items-center rounded bg-primary/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-primary">
                          central
                        </span>
                      ) : (
                        <>
                          <button
                            onClick={() => setActiveChannelKeysId(activeChannelKeysId === channel.id ? null : channel.id)}
                            className={`rounded border px-3 py-1.5 text-xs font-medium transition-colors ${
                              activeChannelKeysId === channel.id
                                ? 'border-border bg-secondary text-foreground'
                                : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                            }`}
                          >
                            API-ключи
                          </button>
                          <button
                            onClick={() => handleDeleteChannel(channel.id, displayTitle)}
                            disabled={deleteChannelMutation.isPending}
                            className="rounded border border-destructive/20 bg-background px-2.5 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-50"
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  </CardContent>
                  {activeChannelKeysId === channel.id && !isCentral && (
                    <div className="border-t border-border/60 bg-muted/20 p-4">
                      <ChannelKeysPanel channelId={channel.id} />
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelKeysPanel({ channelId }: { channelId: number }) {
  const { data, isLoading, isError } = useChannelKeys(channelId);
  const createKeyMutation = useCreateKey(channelId);
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
  if (isError) return <div className="text-xs text-destructive">Не удалось загрузить ключи</div>;

  const keys = data?.keys ?? [];

  const handleCreateKey = async () => {
    setOneTimeKey(null);
    setCopied(false);
    try {
      const res = await createKeyMutation.mutateAsync({ label: 'local collector' });
      if (res.key) setOneTimeKey(res.key);
    } catch {
      alert('Не удалось сгенерировать токен');
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
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Ключи внешних коллекторов</h4>
          <Link to="/connect" className="text-[11px] text-primary hover:underline">Что делать с ключом? →</Link>
        </div>
        <button
          onClick={handleCreateKey}
          disabled={createKeyMutation.isPending}
          className="rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {createKeyMutation.isPending ? 'Генерация…' : 'Создать ключ'}
        </button>
      </div>

      {oneTimeKey && (
        <Card className="border-verdant/40 bg-background">
          <CardContent className="space-y-2.5 p-3.5">
            <div className="text-xs font-semibold text-verdant">⚠️ Скопируйте токен сейчас — он показывается ОДИН раз:</div>
            <div className="relative flex items-center gap-2 break-all rounded bg-muted/60 p-2 font-mono text-xs text-foreground">
              <span className="flex-1 select-all pr-16">{oneTimeKey}</span>
              <button
                onClick={() => handleCopy(oneTimeKey)}
                className="absolute right-2 top-1.5 rounded border bg-background px-2 py-1 font-sans text-[10px] font-medium transition-colors hover:bg-secondary"
              >
                {copied ? 'Скопировано' : 'Копировать'}
              </button>
            </div>
            <div className="text-[11px] leading-normal text-muted-foreground">
              Ingest URL: <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{ingestUrl}</code>
            </div>
          </CardContent>
        </Card>
      )}

      {keys.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">Активных ключей для канала нет.</p>
      ) : (
        <div className="space-y-1.5">
          {keys.map((k) => (
            <div
              key={k.id}
              className={`flex items-center justify-between rounded border border-border/40 bg-background p-2 font-mono text-xs ${k.revoked ? 'opacity-50' : ''}`}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span className="font-semibold text-foreground">{k.key_prefix}…</span>
                <span className="font-sans text-[11px] text-muted-foreground">[{k.label || 'коллектор'}]</span>
                {k.last_used_at && <span className="font-sans text-[10px] text-muted-foreground">использован: {fmt.date(k.last_used_at)}</span>}
              </div>
              <div>
                {k.revoked ? (
                  <span className="font-sans text-[11px] italic text-muted-foreground">отозван</span>
                ) : (
                  <button
                    onClick={() => {
                      if (window.confirm('Отозвать ключ? Коллектор потеряет доступ.')) revokeKeyMutation.mutate(k.id);
                    }}
                    disabled={revokeKeyMutation.isPending}
                    className="font-sans text-[11px] text-destructive hover:underline disabled:opacity-50"
                  >
                    отозвать
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

function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/4" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Card><CardContent className="p-5"><Skeleton className="h-12 w-full" /></CardContent></Card>
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}><CardContent className="p-4"><Skeleton className="h-8 w-full" /></CardContent></Card>
        ))}
      </div>
    </div>
  );
}
