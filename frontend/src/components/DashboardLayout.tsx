import { useEffect } from 'react';
import type { ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useChannels, useLogout } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';

const BASE_TABS = [
  { to: '/', label: 'Обзор', end: true },
  { to: '/analytics', label: 'Аналитика', end: false },
  { to: '/charts', label: 'Графики', end: false },
  { to: '/posts', label: 'Посты', end: false },
  { to: '/mentions', label: 'Упоминания', end: false },
  { to: '/settings', label: 'Настройки', end: false },
];

const SUPER_TABS = [
  { to: '/admin', label: 'Админ', end: false },
  { to: '/bugs', label: 'Баги', end: false },
];

const PERIODS: Array<{ days: PeriodDays; label: string }> = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 365, label: 'Год' },
  { days: 0, label: 'Всё' },
];

interface DashboardLayoutProps {
  email?: string;
  role?: string;
}

/** App shell: sticky top bar with brand, the current user, and tab navigation. */
export function DashboardLayout({ email, role }: DashboardLayoutProps) {
  const tabs = role === 'superuser' ? [...BASE_TABS, ...SUPER_TABS] : BASE_TABS;
  const navigate = useNavigate();
  const logoutMutation = useLogout();

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSettled: () => navigate('/login', { replace: true }),
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <span className="text-sm font-semibold tracking-tight">
            Pulse <span className="text-primary">/app</span>
          </span>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ChannelSwitcher />
            {email && <span className="max-w-[180px] truncate">{email}</span>}
            {role === 'superuser' && (
              <span className="rounded-full border px-2 py-0.5 font-medium">super</span>
            )}
            <button
              type="button"
              onClick={handleLogout}
              disabled={logoutMutation.isPending}
              className="rounded border bg-background px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {logoutMutation.isPending ? 'Выход…' : 'Выйти'}
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
          <PeriodSwitcher />
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}

function PeriodSwitcher() {
  const { days, setDays } = usePeriod();

  return (
    <div className="ml-auto flex shrink-0">
      {PERIODS.map((period) => (
        <button
          key={period.days}
          type="button"
          onClick={() => setDays(period.days)}
          className={`whitespace-nowrap border-b-2 px-2 py-2.5 text-xs font-medium transition-colors ${
            days === period.days
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {period.label}
        </button>
      ))}
    </div>
  );
}

function ChannelSwitcher() {
  const queryClient = useQueryClient();
  const { data } = useChannels();
  const { channelId, setChannelId } = useSelectedChannel();
  const channels = data?.channels ?? [];

  useEffect(() => {
    if (!data || channelId != null || channels.length === 0) return;
    const initial = data.selected ?? channels[0].id;
    setChannelId(initial);
  }, [channelId, channels, data, setChannelId]);

  if (channels.length < 2 || channelId == null) return null;

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const id = Number(event.target.value);
    setChannelId(id);
    void queryClient.cancelQueries();
  };

  return (
    <select
      value={channelId}
      onChange={handleChange}
      className="rounded border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
    >
      {channels.map((channel) => (
        <option key={channel.id} value={channel.id}>
          @{channel.username || channel.title || channel.id}
        </option>
      ))}
    </select>
  );
}
