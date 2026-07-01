import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/nav-icons';
import { Card, CardContent } from '@/components/ui/card';
import { useConnectIg, useIgOauthStatus } from '@/api/queries';

/** Relative "last synced" readout — product language, not a raw timestamp. */
function ago(ms: number): string {
  if (!ms) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
}

function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' }) {
  const dot = tone === 'ok' ? 'bg-verdant' : tone === 'warn' ? 'bg-status-warn' : null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border py-2.5 text-sm first:border-t-0 first:pt-0">
      <span className="shrink-0 text-ink2">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-xs tabular-nums text-ink3">
        {dot && <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />}
        {value}
      </span>
    </div>
  );
}

/**
 * Instagram "Состояние данных" — the TG data-health pattern, in product language: source, account,
 * last sync, access. No env-variable names. Collapsible on mobile, always open on md+.
 */
export function IgDataHealth({ accountName, lastSync, isMock }: { accountName?: string | null; lastSync: number; isMock: boolean }) {
  const [open, setOpen] = useState(false);
  const synced = ago(lastSync);
  return (
    <div>
      {/* One-line status by default — the full technical detail is one click away, not on the first
          level. Status reads as a sentence, not a table. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-sm"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${isMock ? 'bg-status-warn' : 'bg-verdant'}`}
        />
        <span className="min-w-0 truncate text-ink2">
          {isMock ? 'Демо-данные' : 'Данные актуальны'}
          {accountName ? <span className="font-mono text-ink3"> · @{accountName}</span> : null}
          {!isMock ? <span className="text-ink3"> · обновлено {synced}</span> : null}
        </span>
        <Icon name="chevron" className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-ink3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-3 max-w-sm">
          <Row label="Источник" value="Instagram API" />
          <Row label="Статус" value={isMock ? 'демо-данные' : '200 OK'} tone={isMock ? 'warn' : 'ok'} />
          <Row label="Доступ" value="аналитика, медиа" />
          {!isMock && <Row label="Синхронизация" value={synced} />}
        </div>
      )}
    </div>
  );
}

/**
 * Connect panel for the demo / not-connected state. The primary button starts the real OAuth flow
 * (POST /api/ig/oauth/start → top-level redirect to Instagram). When the server isn't configured for
 * connecting (no app credentials / encryption key / DB), the button is disabled with a plain-language
 * hint. Product language only — no environment-variable or token names.
 */
export function IgConnectPanel() {
  const [open, setOpen] = useState(false);
  const status = useIgOauthStatus();
  const connect = useConnectIg();
  const serverReady = status.data?.server_ready ?? false;
  const notReady = status.isSuccess && !serverReady;
  const connectError = connect.error instanceof Error ? connect.error.message : null;
  const requirements = [
    'Аккаунт Instagram Business или Creator.',
    'Вы — администратор этого аккаунта в Instagram.',
    'Нажмите «Подключить» и подтвердите доступ в открывшемся окне Instagram.',
  ];
  const unlocks = [
    'Реальные охваты и просмотры',
    'Демография и география аудитории',
    'Метрики Reels, Stories и публикаций',
    'Действия в профиле и переходы',
  ];
  return (
    <Card className="border-status-warn/40 bg-status-warn/[0.02]">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-status-warn/15 text-status-warn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8h.01M11 12h1v4h1" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-foreground">Демо-режим</h3>
                <span className="rounded-full bg-status-warn/15 px-1.5 py-0.5 text-2xs font-medium text-status-warn">
                  примерные данные
                </span>
              </div>
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                Цифры на этой странице — образец. Подключите бизнес-аккаунт Instagram, чтобы видеть реальные
                охваты, аудиторию и публикации.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-1.5">
            <button
              type="button"
              onClick={() => connect.mutate()}
              disabled={connect.isPending || notReady}
              className="btn-pill bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {connect.isPending ? 'Открываю Instagram…' : 'Подключить Instagram'}
            </button>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="text-center text-2xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
            >
              {open ? 'Скрыть' : 'Что нужно и что даёт'}
            </button>
          </div>
        </div>

        {connectError && <p className="mt-3 text-xs font-medium text-destructive">{connectError}</p>}
        {notReady && (
          <p className="mt-3 text-xs text-muted-foreground">
            Подключение Instagram ещё не настроено на сервере{status.data?.env_fallback ? ' — пока показан общий аккаунт' : ''}.
          </p>
        )}

        {open && (
          <div className="mt-4 grid gap-5 border-t pt-4 sm:grid-cols-2">
            <div>
              <div className="text-2xs font-medium tracking-wide text-muted-foreground">Что нужно для подключения</div>
              <ol className="mt-2 space-y-2">
                {requirements.map((step, i) => (
                  <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-2xs font-medium">
                      {i + 1}
                    </span>
                    <span className="leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-xs text-muted-foreground">После подключения демо-режим отключится автоматически.</p>
            </div>
            <div>
              <div className="text-2xs font-medium tracking-wide text-muted-foreground">Что станет доступно</div>
              <ul className="mt-2 space-y-1.5">
                {unlocks.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-verdant" aria-hidden="true">
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
