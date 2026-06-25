import type { ReactNode } from 'react';
import { useMe } from '@/api/queries';
import { ApiError } from '@/api/client';
import { Hero } from '@/panels/Hero';
import { KpiGrid } from '@/panels/KpiGrid';

export default function App() {
  const me = useMe();

  if (me.isLoading) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Загрузка…</p>
      </Shell>
    );
  }

  if (me.isError) {
    const unauthorized = me.error instanceof ApiError && me.error.status === 401;
    return (
      <Shell>
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-lg font-semibold">{unauthorized ? 'Нужен вход' : 'Не удалось загрузить'}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {unauthorized
              ? 'Войдите в основном дашборде, затем вернитесь сюда.'
              : me.error instanceof Error
                ? me.error.message
                : 'Неизвестная ошибка'}
          </p>
          <a href="/" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
            ← На главный дашборд
          </a>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <Hero />
      <KpiGrid />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold tracking-tight">
            Pulse <span className="text-primary">/app</span>
          </span>
          <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
            3F · новый стек
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-8 px-6 py-8">{children}</main>
    </div>
  );
}
