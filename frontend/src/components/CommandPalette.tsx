import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { useChannels, useLogout, useMe } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { setCommandPaletteOpen, toggleCommandPalette, useCommandPaletteOpen } from '@/lib/command-palette';
import { DRILL_KEYS } from '@/lib/kpiDerive';
import { NETWORKS } from '@/lib/networks';
import { setActiveNetwork } from '@/lib/networkStore';
import { getDrillMetric } from '@/lib/widgetMetrics';
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
  { path: '/posts', label: 'Контент', icon: 'posts', search: 'контент посты публикации posts content' },
  { path: '/mentions', label: 'Упоминания', icon: 'mentions', search: 'упоминания mentions' },
  { path: '/reports', label: 'Отчёты', icon: 'report', search: 'отчёты отчёт отчет reports report документ' },
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

// Сети — из ЕДИНОГО реестра lib/networks (его докстринг: «Everything network-shaped reads THIS
// list»). Локальный кортеж молча выпадал бы из ⌘K при добавлении новой сети (аудит).
const SOURCE_NETWORKS = NETWORKS.map((n) => ({ key: n.key as 'tg' | 'ig', name: n.name, color: n.color, to: n.home }));

/** Tiny brand glyph for a network badge (currentColor; the call site tints it the brand colour). */
function NetworkGlyph({ k }: { k: 'tg' | 'ig' }) {
  if (k === 'tg') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-1.5 w-1.5" aria-hidden="true">
        <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-1.5 w-1.5" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

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
  // The dialog is a separate component mounted per open: an always-mounted component's focus-trap
  // effect would arm exactly once at app boot with a null panel (CommandPalette lives permanently
  // in App). Mount-per-open also resets query/selection naturally and lets the trap restore the
  // ⌘K-time focus position on close.
  if (!open) return null;
  return <PaletteDialog close={() => setOpen(false)} />;
}

function PaletteDialog({ close }: { close: () => void }) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // History is read at mount — i.e. per open (another tab may have added entries since last time).
  const [recents] = useState<string[]>(loadRecents);
  const navigate = useNavigate();
  const me = useMe();
  const channelsQuery = useChannels();
  const logout = useLogout();
  const { setChannelId } = useSelectedChannel();

  // Modal focus contract: the trap arms FIRST (snapshotting the real ⌘K-time opener to restore on
  // close), then the search field takes initial focus. An `autoFocus` attribute would fire during
  // commit — before the trap's effect — corrupting the opener snapshot and then losing focus to
  // the trap's panel.focus().
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(panelRef);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const iconFor = (name: IconName) => <Icon name={name} className="h-4 w-4 shrink-0" />;

  // Hide the Instagram nav shortcuts until some channel has a linked IG account — consistent with
  // the source switcher (no IG surface for unconnected workspaces).
  const anyIgConnected = (channelsQuery.data?.channels ?? []).some((c) => !!c.ig_connected);
  const routeCommands: PaletteCommand[] = [
    ...ROUTES,
    ...(me.data?.role === 'superuser' ? SUPERUSER_ROUTES : []),
  ]
    .filter((route) => anyIgConnected || !route.path.startsWith('/instagram'))
    .map((route) => ({
      id: `route:${route.path}`,
      label: route.label,
      search: `перейти ${route.search}`.toLowerCase(),
      icon: iconFor(route.icon),
      run: () => navigate(route.path),
    }));

  // Metric pages — first-class search targets (steep's «Jump to» reaches metrics too).
  const metricCommands: PaletteCommand[] = DRILL_KEYS.map((key) => {
    const metric = getDrillMetric(key);
    return {
      id: `metric:${key}`,
      label: metric.label,
      search: `метрика ${metric.label}`.toLowerCase(),
      icon: iconFor('analytics'),
      run: () => navigate(`/metrics/${key}`),
    };
  });
  // The IG metric pages too — the list mirrors the MetricRoute dispatcher (IgMetricPage);
  // a new IG metric registers here as well (аудит: палитра не допрыгивала до IG-метрик).
  const IG_METRICS: Array<[string, string]> = [
    ['ig-reach', 'Охват (IG)'],
    ['ig-follows', 'Подписки (IG)'],
    ['ig-views', 'Просмотры (IG)'],
    ['ig-interactions', 'Взаимодействия (IG)'],
    ['ig-likes', 'Лайки (IG)'],
    ['ig-saves', 'Сохранения (IG)'],
    ['ig-er', 'Вовлечённость ER (IG)'],
  ];
  const igMetricCommands: PaletteCommand[] = IG_METRICS.map(([key, term]) => ({
    id: `metric:${key}`,
    label: term,
    search: `метрика instagram ${term}`.toLowerCase(),
    icon: iconFor('analytics'),
    run: () => navigate(`/metrics/${key}`),
  }));

  // Sources = (channel × network). Each channel yields a Telegram row and an Instagram row; picking
  // one selects the channel AND lands on that network — the Cmd+K twin of the sidebar SourceSwitcher.
  const channels = channelsQuery.data?.channels ?? [];
  const sourceCommands: PaletteCommand[] = channels.length >= 2
    ? channels.flatMap((channel) => {
        const name = String(channel.username || channel.title || channel.id);
        const chip = (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-muted text-2xs font-medium text-muted-foreground">
            {name.slice(0, 1).toUpperCase()}
          </span>
        );
        return SOURCE_NETWORKS
          // IG source only for channels with a linked account — mirrors the sidebar switcher.
          .filter((net) => net.key !== 'ig' || !!channel.ig_connected)
          .map((net) => ({
          id: `source:${net.key}:${channel.id}`,
          label: `@${name} · ${net.name}`,
          search: `перейти сменить источник канал ${net.name} ${name}`.toLowerCase(),
          icon: (
            <span className="relative flex shrink-0">
              {chip}
              <span
                className="absolute -bottom-1 -right-1 flex h-2.5 w-2.5 items-center justify-center rounded-full border border-border bg-background"
                style={{ color: net.color }}
                aria-hidden="true"
              >
                <NetworkGlyph k={net.key} />
              </span>
            </span>
          ),
          run: () => {
            setChannelId(channel.id);
            // Persist the network too — the destination owns it, but this avoids a one-frame flash
            // of the previous network in the shell before navigation resolves.
            setActiveNetwork(net.key);
            navigate(net.to);
          },
        }));
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
      // Navigate synchronously: PaletteDialog unmounts right after run(), and React Query drops
      // mutate-level callbacks (like an onSettled navigate) when their observer unmounts before
      // the response. Local session state is cleared by useLogout's own config either way.
      logout.mutate();
      navigate('/login', { replace: true });
    },
  };

  const commands: PaletteCommand[] = [...routeCommands, ...metricCommands,
    ...igMetricCommands, ...sourceCommands, logoutCommand];
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
    if (sourceCommands.length > 0) sections.push({ title: 'Источники', items: sourceCommands });
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
  }, [flatCommands.length, normalizedQuery]);

  const execute = (command: PaletteCommand | undefined) => {
    if (!command) return;
    saveRecent(command.id);
    command.run();
    close();
  };

  return (
    <div
      className="fixed inset-0 z-modal flex items-start justify-center bg-background/70 p-4 pt-[16vh] backdrop-blur-xs backdrop-grayscale"
      onClick={close}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Поиск"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card focus:outline-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Input-first, no title bar (Claude / steep «Jump to»): icon + field + esc chip. */}
        <div className="flex items-center gap-3 px-4">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            // ARIA 1.2 combobox: ↑/↓ move a virtual selection while DOM focus stays here, so the
            // active option must be exposed via aria-activedescendant — without it a screen reader
            // hears nothing on the advertised «↑↓ — навигация» and Enter runs an unnamed command.
            role="combobox"
            aria-label="Поиск"
            aria-expanded={flatCommands.length > 0}
            aria-autocomplete="list"
            aria-controls={flatCommands.length > 0 ? 'cp-list' : undefined}
            aria-activedescendant={flatCommands.length > 0 ? `cp-opt-${selectedIndex}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Scroll only on KEYBOARD moves (the list scrolls at max-h-[46vh] while ↑/↓ drive a
              // virtual selection). Hover also moves the selection — scrolling there would jump
              // the list under a stationary cursor and creep it via re-fired mouseenter.
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (flatCommands.length === 0) return;
                const next =
                  event.key === 'ArrowDown'
                    ? (selectedIndex + 1) % flatCommands.length
                    : (selectedIndex - 1 + flatCommands.length) % flatCommands.length;
                setSelectedIndex(next);
                document.getElementById(`cp-opt-${next}`)?.scrollIntoView({ block: 'nearest' });
              } else if (event.key === 'Enter') {
                event.preventDefault();
                execute(flatCommands[selectedIndex]);
              }
            }}
            placeholder="Поиск: разделы, метрики, источники…"
            className="min-w-0 flex-1 bg-transparent py-3.5 text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">esc</kbd>
        </div>

        <div className="max-h-[46vh] overflow-y-auto border-t border-border p-2">
          {flatCommands.length > 0 ? (
            // The listbox half of the combobox. Sections are role=group children (a listbox may
            // contain only options/groups), their visual titles hidden from AT in favour of the
            // groups' accessible names.
            <div id="cp-list" role="listbox" aria-label="Команды">
              {sections.map((section, s) =>
                section.items.length === 0 ? null : (
                  <div key={section.title ?? 'hits'} role="group" aria-label={section.title ?? 'Результаты'}>
                    {section.title && (
                      <div aria-hidden="true" className="px-3 pb-1 pt-3 text-2xs font-medium uppercase tracking-wide text-ink3 first:pt-1.5">
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
                          id={`cp-opt-${index}`}
                          role="option"
                          aria-selected={active}
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
              )}
            </div>
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
