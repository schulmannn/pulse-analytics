import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannels, useLogout, useMe } from '@/api/queries';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useSelectedChannel } from '@/lib/channel-context';

interface PaletteCommand {
  id: string;
  label: string;
  search: string;
  run: () => void;
}

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return { open, setOpen };
}

const ROUTES = [
  { path: '/', label: 'Обзор' },
  { path: '/analytics', label: 'Аналитика' },
  { path: '/posts', label: 'Посты' },
  { path: '/mentions', label: 'Упоминания' },
  { path: '/settings', label: 'Настройки' },
];

const SUPERUSER_ROUTES = [
  { path: '/admin', label: 'Админ' },
  { path: '/bugs', label: 'Баги' },
];

export function CommandPalette() {
  const { open, setOpen } = useCommandPalette();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const navigate = useNavigate();
  const me = useMe();
  const channelsQuery = useChannels();
  const logout = useLogout();
  const { setChannelId } = useSelectedChannel();

  const close = () => {
    setOpen(false);
    setQuery('');
    setSelectedIndex(0);
  };

  const routeCommands: PaletteCommand[] = [
    ...ROUTES,
    ...(me.data?.role === 'superuser' ? SUPERUSER_ROUTES : []),
  ].map((route) => ({
    id: `route:${route.path}`,
    label: `Перейти: ${route.label}`,
    search: `перейти раздел ${route.label}`.toLowerCase(),
    run: () => navigate(route.path),
  }));

  const channels = channelsQuery.data?.channels ?? [];
  const channelCommands: PaletteCommand[] = channels.length >= 2
    ? channels.map((channel) => {
        const name = channel.username || channel.title || String(channel.id);
        return {
          id: `channel:${channel.id}`,
          label: `Сменить канал: @${name}`,
          search: `сменить канал ${name}`.toLowerCase(),
          run: () => setChannelId(channel.id),
        };
      })
    : [];

  const commands: PaletteCommand[] = [
    ...routeCommands,
    ...channelCommands,
    {
      id: 'logout',
      label: 'Выйти',
      search: 'выйти выход logout',
      run: () => {
        logout.mutate(undefined, {
          onSettled: () => navigate('/login', { replace: true }),
        });
      },
    },
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const filteredCommands = normalizedQuery
    ? commands.filter((command) => command.search.includes(normalizedQuery))
    : commands;

  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands.length, normalizedQuery, open]);

  if (!open) return null;

  const execute = (command: PaletteCommand | undefined) => {
    if (!command) return;
    command.run();
    close();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[15vh]"
      onClick={close}
    >
      <Card
        role="dialog"
        aria-modal="true"
        aria-label="Командная палитра"
        className="w-full max-w-xl overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex-row items-center justify-between space-y-0 border-b p-4">
          <CardTitle className="text-sm">Командная палитра</CardTitle>
          <button
            type="button"
            onClick={close}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Закрыть"
          >
            ×
          </button>
        </CardHeader>
        <CardContent className="p-0">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelectedIndex((index) => (
                  filteredCommands.length > 0 ? (index + 1) % filteredCommands.length : 0
                ));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelectedIndex((index) => (
                  filteredCommands.length > 0
                    ? (index - 1 + filteredCommands.length) % filteredCommands.length
                    : 0
                ));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                execute(filteredCommands[selectedIndex]);
              }
            }}
            placeholder="Найти команду…"
            className="w-full border-b bg-background px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-inset focus:ring-primary"
          />
          <div className="max-h-80 overflow-y-auto p-2">
            {filteredCommands.length > 0 ? (
              filteredCommands.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => execute(command)}
                  className={`block w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                    index === selectedIndex
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {command.label}
                </button>
              ))
            ) : (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                Команды не найдены
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
