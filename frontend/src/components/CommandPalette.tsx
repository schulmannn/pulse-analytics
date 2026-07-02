import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannels, useLogout, useMe } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { setCommandPaletteOpen, toggleCommandPalette, useCommandPaletteOpen } from '@/lib/command-palette';
import { DRILL_KEYS } from '@/lib/kpiDerive';
import { METRIC_DEFS } from '@/lib/metricDefs';
import { Icon } from '@/components/nav-icons';
import type { IconName } from '@/components/nav-icons';

interface PaletteCommand {
  id: string;
  label: string;
  search: string;
  icon?: ReactNode;
  run: () => void;
}

interface PaletteSection {
  title: string | null;
  items: PaletteCommand[];
}

/** Open-state lives in the shared store (lib/command-palette) so any control can call
    openCommandPalette(); this hook adds the ⌘K / Ctrl+K / Escape keyboard wiring. */
export function useCommandPalette() {
  const { open, setOpen } = useCommandPaletteOpen();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        toggleCommandPalette();
      } else if (event.key === 'Escape') {
        setCommandPaletteOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return { open, setOpen };
}

const ROUTES: Array<{ path: string; label: string; icon: IconName; search: string }> = [
  { path: '/', label: 'Обзор', icon: 'overview', search: 'обзор главная overview' },
  { path: '/analytics', label: 'Аналитика', icon: 'analytics', search: 'аналитика графики analytics' },
  { path: '/posts', label: 'Посты', icon: 'posts', search: 'посты публикации posts' },
  { path: '/mentions', label: 'Упоминания', icon: 'mentions', search: 'упоминания mentions' },
  { path: '/report', label: 'Отчёт', icon: 'report', search: 'отчёт отчет report документ' },
  { path: '/instagram', label: 'Instagram · Обзор', icon: 'overview', search: 'instagram инстаграм обзор' },
  { path: '/instagram/analytics', label: 'Instagram · Аналитика', icon: 'analytics', search: 'instagram инстаграм аналитика' },
  { path: '/instagram/content', label: 'Instagram · Контент', icon: 'posts', search: 'instagram инстаграм контент посты' },
  { path: '/instagram/audience', label: 'Instagram · Аудитория', icon: 'audience', search: 'instagram инстаграм аудитория' },
  { path: '/settings', label: 'Настройки', icon: 'gear', search: 'настройки settings' },
];

const SUPERUSER_ROUTES: Array<{ path: string; label: string; icon: IconName; search: string }> = [
  { path: '/admin', label: 'Админ', icon: 'admin', search: 'админ admin' },
  { path: '/bugs', label: 'Баги', icon: 'bugs', search: 'баги bugs фидбек' },
];

// Search history (MRU command ids) — the palette opens on «Недавнее», like Claude's search.
const RECENTS_KEY = 'pulse_palette_recents';
const RECENTS_MAX = 6;

function loadRecents(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecent(id: string) {
  const next = [id, ...loadRecents().filter((x) => x !== id)].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage full/blocked — recents are a nicety */
  }
}

export function CommandPalette() {
  const { open, setOpen } = useCommandPalette();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const navigate = useNavigate();
  const me = useMe();
  const channelsQuery = useChannels();
  const logout = useLogout();
  const { setChannelId } = useSelectedChannel();

  // Re-read the history each time the palette opens (another tab may have added entries).
  useEffect(() => {
    if (open) setRecents(loadRecents());
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setSelectedIndex(0);
  };

  const iconFor = (name: IconName) => <Icon name={name} className="h-4 w-4 shrink-0" />;

  const routeCommands: PaletteCommand[] = [
    ...ROUTES,
    ...(me.data?.role === 'superuser' ? SUPERUSER_ROUTES : []),
  ].map((route) => ({
    id: `route:${route.path}`,
    label: route.label,
    search: `перейти ${route.search}`.toLowerCase(),
    icon: iconFor(route.icon),
    run: () => navigate(route.path),
  }));

  // Metric pages — first-class search targets (steep's «Jump to» reaches metrics too).
  const metricCommands: PaletteCommand[] = DRILL_KEYS.map((key) => ({
    id: `metric:${key}`,
    label: METRIC_DEFS[key].term,
    search: `метрика ${METRIC_DEFS[key].term}`.toLowerCase(),
    icon: iconFor('analytics'),
    run: () => navigate(`/metrics/${key}`),
  }));

  const channels = channelsQuery.data?.channels ?? [];
  const channelCommands: PaletteCommand[] = channels.length >= 2
    ? channels.map((channel) => {
        const name = channel.username || channel.title || String(channel.id);
        return {
          id: `channel:${channel.id}`,
          label: `@${name}`,
          search: `сменить канал ${name}`.toLowerCase(),
          icon: (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-muted text-2xs font-medium text-muted-foreground">
              {String(name).slice(0, 1).toUpperCase()}
            </span>
          ),
          run: () => setChannelId(channel.id),
        };
      })
    : [];

  const logoutCommand: PaletteCommand = {
    id: 'logout',
    label: 'Выйти',
    search: 'выйти выход logout',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0" aria-hidden="true">
        <path d="M6 3H3.5v10H6M10 5l3 3-3 3M13 8H6.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    run: () => {
      logout.mutate(undefined, {
        onSettled: () => navigate('/login', { replace: true }),
      });
    },
  };

  const commands: PaletteCommand[] = [...routeCommands, ...metricCommands, ...channelCommands, logoutCommand];
  const normalizedQuery = query.trim().toLowerCase();

  // Empty query = browsable groups with the history on top; a query = one flat hit list.
  const sections: PaletteSection[] = [];
  if (normalizedQuery) {
    sections.push({ title: null, items: commands.filter((c) => c.search.includes(normalizedQuery)) });
  } else {
    const byId = new Map(commands.map((c) => [c.id, c]));
    const recentItems = recents
      .map((id) => byId.get(id))
      .filter((c): c is PaletteCommand => c !== undefined);
    if (recentItems.length > 0) sections.push({ title: 'Недавнее', items: recentItems });
    sections.push({ title: 'Разделы', items: routeCommands });
    sections.push({ title: 'Метрики', items: metricCommands });
    if (channelCommands.length > 0) sections.push({ title: 'Каналы', items: channelCommands });
    sections.push({ title: 'Аккаунт', items: [logoutCommand] });
  }
  const flatCommands = sections.flatMap((s) => s.items);
  // Per-section start offset → a row's flat index = offset + position (keyboard selection
  // walks the flat list while the render stays grouped).
  const offsets: number[] = [];
  {
    let acc = 0;
    for (const section of sections) {
      offsets.push(acc);
      acc += section.items.length;
    }
  }

  useEffect(() => {
    setSelectedIndex(0);
  }, [flatCommands.length, normalizedQuery, open]);

  if (!open) return null;

  const execute = (command: PaletteCommand | undefined) => {
    if (!command) return;
    saveRecent(command.id);
    command.run();
    close();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 p-4 pt-[16vh] backdrop-blur-sm"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Поиск"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Input-first, no title bar (Claude / steep «Jump to»): icon + field + esc chip. */}
        <div className="flex items-center gap-3 px-4">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelectedIndex((index) => (
                  flatCommands.length > 0 ? (index + 1) % flatCommands.length : 0
                ));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelectedIndex((index) => (
                  flatCommands.length > 0
                    ? (index - 1 + flatCommands.length) % flatCommands.length
                    : 0
                ));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                execute(flatCommands[selectedIndex]);
              }
            }}
            placeholder="Поиск: разделы, метрики, каналы…"
            className="min-w-0 flex-1 bg-transparent py-3.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">esc</kbd>
        </div>

        <div className="max-h-[46vh] overflow-y-auto border-t border-border p-2">
          {flatCommands.length > 0 ? (
            sections.map((section, s) =>
              section.items.length === 0 ? null : (
                <div key={section.title ?? 'hits'}>
                  {section.title && (
                    <div className="px-3 pb-1 pt-3 text-2xs uppercase tracking-wider text-muted-foreground first:pt-1.5">
                      {section.title}
                    </div>
                  )}
                  {section.items.map((command, i) => {
                    const index = offsets[s] + i;
                    const active = index === selectedIndex;
                    return (
                      <button
                        key={`${section.title ?? 'hits'}:${command.id}`}
                        type="button"
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => execute(command)}
                        className={`flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm transition-colors ${
                          active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        {command.icon ?? <span className="h-4 w-4 shrink-0" aria-hidden="true" />}
                        <span className="min-w-0 flex-1 truncate">{command.label}</span>
                        {active && (
                          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                            ⏎
                          </kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              ),
            )
          ) : (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              Ничего не нашлось
            </div>
          )}
        </div>

        {/* Footer hints (steep/Claude): quiet keyboard legend, no chrome. */}
        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-2xs text-muted-foreground">
          <span>↑↓ — навигация</span>
          <span>⏎ — открыть</span>
          <span>esc — закрыть</span>
        </div>
      </div>
    </div>
  );
}
