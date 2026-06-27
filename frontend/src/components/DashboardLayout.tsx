import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useChannels, useLogout } from '@/api/queries';
import { ThemeToggle } from '@/components/ThemeToggle';
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
            {/* DESIGN: Claude review */}
            <ThemeToggle />
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

const tabBtn = (active: boolean) =>
  `whitespace-nowrap border-b-2 px-2 py-2.5 text-xs font-medium transition-colors ${
    active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
  }`;

const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

function PeriodSwitcher() {
  const { days, setDays, range, setRange } = usePeriod();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);

  const toggle = () => {
    if (open) return setOpen(false);
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };

  const apply = () => {
    const f = Date.parse(from);
    const t = Date.parse(to);
    if (!Number.isFinite(f) || !Number.isFinite(t) || f > t) return;
    setRange({ from: f, to: t + 24 * 60 * 60 * 1000 - 1 }); // inclusive end-of-day
    setOpen(false);
  };

  const reset = () => {
    setFrom('');
    setTo('');
    setDays(30); // also clears the range
    setOpen(false);
  };

  return (
    <div className="ml-auto flex shrink-0 items-stretch">
      {PERIODS.map((period) => (
        <button
          key={period.days}
          type="button"
          onClick={() => setDays(period.days)}
          className={tabBtn(range === null && days === period.days)}
        >
          {period.label}
        </button>
      ))}
      {/* DESIGN: Claude review */}
      <button ref={btnRef} type="button" onClick={toggle} className={tabBtn(range !== null)} title="Произвольный период">
        {range ? `${shortDate(range.from)}–${shortDate(range.to)}` : '⋯'}
      </button>

      {open && pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-60 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
            style={{ top: pos.top, right: pos.right }}
          >
            <div className="space-y-2">
              <label className="block text-[11px] font-medium text-muted-foreground">
                С
                <input
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  className="mt-1 w-full rounded border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </label>
              <label className="block text-[11px] font-medium text-muted-foreground">
                По
                <input
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  className="mt-1 w-full rounded border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </label>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={apply}
                  className="flex-1 rounded bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Применить
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="rounded border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  Сброс
                </button>
              </div>
            </div>
          </div>
        </>
      )}
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
