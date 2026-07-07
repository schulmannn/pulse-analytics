import { useEffect, useState } from 'react';
import { Outlet, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useIgData } from '@/lib/useIgData';
import type { IgData } from '@/lib/useIgData';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { IgConnectPanel, IgDataHealth } from '@/components/instagram/health';
import { DateRangePicker } from '@/components/DateRangePicker';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { IgOverview } from '@/panels/instagram/IgOverview';
import { IgAnalytics } from '@/panels/instagram/IgAnalytics';
import { IgContent } from '@/panels/instagram/IgContent';
import { IgAudience } from '@/panels/instagram/IgAudience';

/**
 * IG feed SHELL — the IG side now runs the SAME focused-pages model as TG: one layout route with
 * network-wide chrome (account header, data health, OAuth-callback notices, the demo connect
 * panel, the loading/error gates) and the addressed section rendered через <Outlet/>. What each
 * section renders lives in the FEED REGISTRY (panels/feed/feeds.tsx) — this closed the last
 * structural TG↔IG fork (TG = pages, IG = scroll-feed), and the scroll engine (useFeed) retired
 * with it.
 *
 * Data delivery: the shell calls {@link useIgData} ONCE and hands the cluster to the section
 * pages via Outlet context (the focused-pages twin of the old feed's prop threading) — the ig-*
 * queries stay deduped by React Query, and the igMetrics math runs once per page, not once per
 * section body.
 */

// Plain-language messages for the ?ig_error= codes the OAuth callback bounces back with.
const IG_ERROR_MESSAGES: Record<string, string> = {
  denied: 'Доступ в Instagram не подтверждён — подключение отменено.',
  state: 'Ссылка подключения истекла — попробуйте ещё раз.',
  server: 'Подключение Instagram не настроено на сервере.',
  auth: 'Сессия недействительна — войдите снова и повторите.',
  channel: 'Нет доступа к выбранному каналу.',
  exchange: 'Instagram не выдал токен — попробуйте ещё раз.',
  identity: 'Не удалось получить данные аккаунта Instagram.',
};

/** Reads the OAuth callback flag (?ig=connected / ?ig_error=…) once, refetches IG data on success,
 *  then strips the flag from the URL so a reload doesn't re-show the banner. */
function useIgConnectNotice() {
  const qc = useQueryClient();
  const { setChannelId } = useSelectedChannel();
  const [params, setParams] = useSearchParams();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  useEffect(() => {
    const connected = params.get('ig') === 'connected';
    const err = params.get('ig_error');
    if (!connected && !err) return;
    setNotice(
      connected
        ? { kind: 'ok', msg: 'Instagram подключён — загружаем реальные данные.' }
        : { kind: 'err', msg: IG_ERROR_MESSAGES[err ?? ''] || 'Не удалось подключить Instagram.' },
    );
    if (connected) {
      // The callback names the (possibly freshly created) source — switch to it so the user
      // lands on the account they just connected, not whatever was selected before.
      const ch = parseInt(params.get('ch') ?? '', 10);
      if (Number.isFinite(ch) && ch > 0) {
        setChannelId(ch);
        qc.invalidateQueries({ queryKey: ['channels'] });
      }
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('ig-') });
    }
    // Strip the flag so a reload doesn't re-show it. setParams is stable, so this re-runs the effect
    // once with the flag already gone → early return, no loop. Keeping params in deps makes the
    // banner react to a fresh ?ig= landing even if the component is already mounted.
    const next = new URLSearchParams(params);
    next.delete('ig');
    next.delete('ig_error');
    next.delete('ch');
    setParams(next, { replace: true });
  }, [params, qc, setParams, setChannelId]);
  return { notice, dismiss: () => setNotice(null) };
}

/** Window presets for the IG period chips. IG reads the GLOBAL usePeriod (via useIgData), so the
    control re-windows every IG card; it now sits in each section's sticky header (TG parity) —
    same value on every page, one placement rule everywhere. */
const IG_PERIOD_PRESETS: { days: PeriodDays; label: string }[] = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

/** Short «дд.мм» for the active custom-range chip label. */
const fmtRangeChip = (ms: number) => new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

export function IgPeriodControl() {
  const { days, range, setDays, setRange } = usePeriod();
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div role="group" aria-label="Период" className="relative flex flex-wrap items-center gap-1.5">
      {IG_PERIOD_PRESETS.map((chip) => (
        <button
          key={chip.days}
          type="button"
          onClick={() => setDays(chip.days)}
          aria-pressed={!range && days === chip.days}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
            !range && days === chip.days
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {chip.label}
        </button>
      ))}
      {/* Custom date range — filters the posts list (Контент) and every windowed metric to an exact
          period. Picking a preset above clears the range (usePeriod.setDays resets it). */}
      <button
        type="button"
        onClick={() => setPickerOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        aria-pressed={!!range}
        className={cn(
          'rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
          range
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'border-border text-muted-foreground hover:text-foreground',
        )}
      >
        {range ? `${fmtRangeChip(range.from)} – ${fmtRangeChip(range.to)}` : 'Свой период'}
      </button>
      {pickerOpen && (
        <>
          {/* Scrim closes the popover on an outside click / Esc-less dismissal. */}
          <div className="fixed inset-0 z-popover" aria-hidden="true" onClick={() => setPickerOpen(false)} />
          <div className="absolute right-0 top-full z-popover mt-2 rounded-lg border border-border bg-card p-3">
            <DateRangePicker
              value={range}
              onApply={(r) => {
                setRange(r);
                setPickerOpen(false);
              }}
              onReset={() => {
                setRange(null);
                setPickerOpen(false);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

export function IgShell() {
  // The whole IG data cluster, fetched ONCE (React Query dedupes the underlying ig-* queries).
  const ig = useIgData();
  const { notice, dismiss } = useIgConnectNotice();

  const banner = notice ? (
    <div
      className={cn(
        'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm',
        notice.kind === 'ok' ? 'border-verdant/40 bg-verdant/[0.05]' : 'border-destructive/40 bg-destructive/[0.04]',
      )}
    >
      <span className="text-foreground">{notice.msg}</span>
      <button type="button" onClick={dismiss} aria-label="Закрыть" className="shrink-0 text-muted-foreground hover:text-foreground">
        ✕
      </button>
    </div>
  ) : null;

  if (ig.loading) return <div className="space-y-6">{banner}<InstagramSkeleton /></div>;
  if (ig.error) {
    return (
      <div className="space-y-6">
        {banner}
        <ErrorState title="Не удалось загрузить данные Instagram" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {banner}
      {/* Network-wide chrome — rendered once, above the section card (the account context). */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-medium tracking-tight">
            Instagram{ig.profile?.username ? ` · @${ig.profile.username}` : ''}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {ig.isMock ? 'Демо-режим — примерные данные' : 'Аккаунт, аудитория, форматы и публикации'}
          </p>
        </div>
        {/* Tiny data-status indicator (account-card area). No accountName here — the H2 on the
            left already says «Instagram · @handle»; the same handle twice in one row read as an
            echo (аудит). The period chips moved into the section headers (TG parity). */}
        <div className="min-w-[180px] shrink-0">
          <IgDataHealth lastSync={ig.lastSync} isMock={ig.isMock} />
        </div>
      </header>
      {ig.isMock && <IgConnectPanel />}

      <Outlet context={ig} />
    </div>
  );
}

/** The section pages read the shell's IG cluster from the Outlet context. */
function useIg(): IgData {
  return useOutletContext<IgData>();
}

export function IgOverviewPage() {
  return <IgOverview ig={useIg()} />;
}
export function IgAnalyticsPage() {
  return <IgAnalytics ig={useIg()} />;
}
export function IgContentPage() {
  return <IgContent ig={useIg()} />;
}
export function IgAudiencePage() {
  return <IgAudience ig={useIg()} />;
}

function InstagramSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="space-y-3 p-4">
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-10 w-2/5" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    </div>
  );
}
