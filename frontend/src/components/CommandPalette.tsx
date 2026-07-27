import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannels, useLogout, useMe } from '@/api/queries';
import { accountExitLabel, runAccountExit } from '@/lib/accountExit';
import { useSelectedChannel } from '@/lib/channel-context';
import { useCommandPaletteOpen } from '@/lib/command-palette';
import { DRILL_KEYS } from '@/lib/kpiDerive';
import { NetworkGlyph } from '@/lib/networks';
import { setActiveNetwork } from '@/lib/networkStore';
import { useDemo } from '@/lib/demo-context';
import {
  buildIgMetricCommands,
  buildNetworkRouteCommands,
  buildSourceCommands,
} from '@/lib/paletteCommands';
import type { PaletteChannel } from '@/lib/paletteCommands';
import { getDrillMetric } from '@/lib/widgetMetrics';
import { Icon } from '@/components/nav-icons';
import type { IconName } from '@/components/nav-icons';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

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

// Сетевые разделы (Обзор/Аналитика/Контент/… каждой сети) строятся из реестра lib/networks —
// см. lib/paletteCommands. Здесь остаются ТОЛЬКО маршруты вне сетей: их ни один реестр не описывает.
const EXTRA_ROUTES: Array<{ path: string; label: string; icon: IconName; search: string }> = [
  { path: '/reports', label: 'Отчёты', icon: 'report', search: 'отчёты отчёт отчет reports report документ' },
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
  const { open, setOpen } = useCommandPaletteOpen();
  // Mount-per-open (как и раньше): query/recents сбрасываются естественно, cmdk строит список
  // заново на каждое открытие (recents другой вкладки подтягиваются при следующем ⌘K).
  if (!open) return null;
  return <PaletteDialog close={() => setOpen(false)} />;
}

function PaletteDialog({ close }: { close: () => void }) {
  const [query, setQuery] = useState('');
  // History is read at mount — i.e. per open (another tab may have added entries since last time).
  const [recents] = useState<string[]>(loadRecents);
  const navigate = useNavigate();
  const me = useMe();
  const channelsQuery = useChannels();
  const logout = useLogout();
  const { demo, exitDemo } = useDemo();
  const { setChannelId } = useSelectedChannel();

  const iconFor = (name: IconName) => <Icon name={name} className="h-4 w-4 shrink-0" />;

  // Разделы: сетевые — из реестра (сеть показывается, только если её выставляет хотя бы один канал
  // мастерской: тот же предикат hasChannel, что у сайдбара и SourceSwitcher), затем внесетевые.
  const channels: PaletteChannel[] = channelsQuery.data?.channels ?? [];
  const routeCommands: PaletteCommand[] = [
    ...buildNetworkRouteCommands(channels),
    ...EXTRA_ROUTES.map((route) => ({ ...route, id: `route:${route.path}`, search: `перейти ${route.search}`.toLowerCase() })),
    ...(me.data?.role === 'superuser'
      ? SUPERUSER_ROUTES.map((route) => ({ ...route, id: `route:${route.path}`, search: `перейти ${route.search}`.toLowerCase() }))
      : []),
  ].map((route) => ({
    id: route.id,
    label: route.label,
    search: route.search,
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
  // IG-метрики — тем же реестровым гейтом, что и IG-разделы (раньше показывались всегда).
  const igMetricCommands: PaletteCommand[] = buildIgMetricCommands(channels).map((metric) => ({
    id: metric.id,
    label: metric.label,
    search: metric.search,
    icon: iconFor('analytics'),
    run: () => navigate(`/metrics/${metric.key}`),
  }));

  // Sources = (channel × network), где пара реально существует (реестровый hasChannel): выбор
  // селектит канал И приземляет на эту сеть — ⌘K-двойник сайдбарного SourceSwitcher. Глиф — тот же
  // реестровый NetworkGlyph, что рисует сети в сайдбаре (третьей копии SVG в приложении нет).
  const sourceCommands: PaletteCommand[] = buildSourceCommands(channels).map((source) => ({
    id: source.id,
    label: source.label,
    search: source.search,
    icon: (
      <span className="relative flex shrink-0">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-muted text-2xs font-medium text-muted-foreground">
          {source.channelName.slice(0, 1).toUpperCase()}
        </span>
        <span
          className="absolute -bottom-1 -right-1 flex h-2.5 w-2.5 items-center justify-center rounded-full border border-border bg-background"
          style={{ color: source.network.color }}
          aria-hidden="true"
        >
          <NetworkGlyph k={source.network.key} className="h-1.5 w-1.5" />
        </span>
      </span>
    ),
    run: () => {
      setChannelId(source.channelId);
      // Persist the network too — the destination owns it, but this avoids a one-frame flash
      // of the previous network in the shell before navigation resolves.
      setActiveNetwork(source.network.key);
      navigate(source.network.home);
    },
  }));

  const logoutCommand: PaletteCommand = {
    id: 'logout',
    label: accountExitLabel(demo, logout.isPending),
    search: demo ? 'выйти из демо выход demo' : 'выйти выход logout',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0" aria-hidden="true">
        <path d="M6 3H3.5v10H6M10 5l3 3-3 3M13 8H6.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    run: () => {
      runAccountExit({
        demo,
        exitDemo,
        // HttpOnly cookie can only be cleared by a successful server response. Keep the
        // authenticated surface on network failure instead of creating a login bounce.
        logout: () =>
          logout.mutate(undefined, {
            onSuccess: () => navigate('/login', { replace: true }),
          }),
      });
    },
  };

  const groups: PaletteSection[] = [
    { title: 'Разделы', items: routeCommands },
    { title: 'Метрики', items: [...metricCommands, ...igMetricCommands] },
    ...(sourceCommands.length > 0 ? [{ title: 'Источники', items: sourceCommands }] : []),
    { title: 'Аккаунт', items: [logoutCommand] },
  ];
  const byId = new Map(groups.flatMap((g) => g.items).map((c) => [c.id, c]));
  const recentItems = recents
    .map((id) => byId.get(id))
    .filter((c): c is PaletteCommand => c !== undefined);

  const execute = (command: PaletteCommand) => {
    saveRecent(command.id);
    command.run();
    close();
  };

  // cmdk владеет фильтрацией (fuzzy, command-score), клавиатурой и ARIA-комбобоксом — ручной
  // flat-index/aria-activedescendant слой ушёл целиком. value = label; старые substring-термины
  // уехали в keywords, так что прежние запросы находят то же самое (но опечатко-устойчивее).
  // «Недавнее» видно только на пустом запросе (как раньше); дубли id между «Недавнее» и группами
  // разведены value-префиксом.
  return (
    <CommandDialog
      open
      onOpenChange={(nextOpen) => !nextOpen && close()}
      title="Поиск"
      description="Поиск: разделы, метрики, источники"
      className="top-[16vh] max-w-xl translate-y-0 gap-0"
    >
      <div className="flex items-center gap-1 pr-4 [&_[data-slot=command-input-wrapper]]:h-12 [&_[data-slot=command-input-wrapper]]:flex-1 [&_[data-slot=command-input-wrapper]]:border-b-0 [&_[data-slot=command-input-wrapper]]:px-4">
        <CommandInput
          aria-label="Поиск"
          value={query}
          onValueChange={setQuery}
          placeholder="Поиск: разделы, метрики, источники…"
        />
        <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">esc</kbd>
      </div>
      <CommandList className="max-h-[46vh] border-t border-border p-2">
        <CommandEmpty className="px-3 py-8 text-center text-sm text-muted-foreground">Ничего не нашлось</CommandEmpty>
        {!query && recentItems.length > 0 && (
          <CommandGroup heading="Недавнее">
            {recentItems.map((command) => (
              <PaletteRow key={`recent:${command.id}`} command={command} valuePrefix="recent:" onRun={execute} />
            ))}
          </CommandGroup>
        )}
        {groups.map((group) => (
          <CommandGroup key={group.title} heading={group.title ?? undefined}>
            {group.items.map((command) => (
              <PaletteRow key={command.id} command={command} onRun={execute} />
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      {/* Footer hints (steep/Claude): quiet keyboard legend, no chrome. */}
      <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-2xs text-muted-foreground">
        <span>↑↓ — навигация</span>
        <span>⏎ — открыть</span>
        <span>esc — закрыть</span>
      </div>
    </CommandDialog>
  );
}

/** Одна строка палитры: канон-вид (иконка + label) поверх cmdk CommandItem. */
function PaletteRow({
  command,
  onRun,
  valuePrefix = '',
}: {
  command: PaletteCommand;
  onRun: (command: PaletteCommand) => void;
  valuePrefix?: string;
}) {
  return (
    <CommandItem
      value={`${valuePrefix}${command.label}`}
      keywords={command.search.split(/\s+/)}
      onSelect={() => onRun(command)}
      className="gap-2.5 px-3 py-2 text-sm text-muted-foreground data-[selected=true]:bg-muted data-[selected=true]:text-foreground"
    >
      {command.icon ?? <span className="h-4 w-4 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{command.label}</span>
    </CommandItem>
  );
}
