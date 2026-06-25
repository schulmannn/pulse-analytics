import { NavLink, Outlet } from 'react-router-dom';

const TABS = [
  { to: '/', label: 'Обзор', end: true },
  { to: '/charts', label: 'Графики', end: false },
  { to: '/posts', label: 'Посты', end: false },
  { to: '/mentions', label: 'Упоминания', end: false },
];

interface DashboardLayoutProps {
  email?: string;
  role?: string;
}

/** App shell: sticky top bar with brand, the current user, and tab navigation. */
export function DashboardLayout({ email, role }: DashboardLayoutProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <span className="text-sm font-semibold tracking-tight">
            Pulse <span className="text-primary">/app</span>
          </span>
          {email && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="max-w-[180px] truncate">{email}</span>
              {role === 'superuser' && (
                <span className="rounded-full border px-2 py-0.5 font-medium">super</span>
              )}
            </div>
          )}
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4">
          {TABS.map((t) => (
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
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
