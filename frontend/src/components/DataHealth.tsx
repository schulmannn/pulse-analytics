import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useChannels, useCollectorStatus, useHistory, useTgQrStatus } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { freshness, latestHistoryDay } from '@/lib/freshness';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/nav-icons';

/**
 * "Состояние данных" keeps the selected channel's collection mode honest: managed MTProto,
 * managed QR, or the external collector. The compact summary expands into source-specific health
 * and sends repairable connections straight to the matching setup tab.
 */
function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'error' }) {
  const dot = tone === 'ok' ? 'bg-verdant' : tone === 'warn' ? 'bg-status-warn' : tone === 'error' ? 'bg-ember' : null;
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

export function DataHealth({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const [open, setOpen] = useState(defaultOpen);
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const current = channelsData?.channels.find((c) => c.id === channelId) ?? channelsData?.channels[0];
  const isCentral = current?.source === 'central';
  const isQr = current?.source === 'qr';
  const isCollector = current?.source === 'collector' || current?.source == null;
  const { data: collector } = useCollectorStatus(isCollector && current ? current.id : null);
  const { data: qr } = useTgQrStatus(isQr);
  const { data: history } = useHistory(730);
  const fresh = freshness(latestHistoryDay(history), Date.now());

  const status = collector?.status;
  const qrState = qr?.connection_state;
  const source = isCentral ? 'Telegram · MTProto' : isQr ? 'Telegram · QR' : 'Telegram · Collector';
  const lastSuccess = isQr ? qr?.last_success_at : status?.last_success_at;
  const lastCollect = lastSuccess ? fmt.date(lastSuccess) : fresh?.label ?? '—';
  const collectionMode = isCentral
    ? 'MTProto'
    : isQr
      ? 'Atlavue'
      : status?.collector_version
        ? `Collector v${status.collector_version}`
        : 'Collector';

  // Exact QR auth state wins over freshness; transient and collector failures stay warnings/errors
  // of their own instead of being flattened into a generic stale-data message.
  let apiTone: 'ok' | 'warn' | 'error' = 'ok';
  let apiText = '200 OK';
  if (isQr && qrState === 'reauth_required') {
    apiTone = 'error';
    apiText = 'нужен вход';
  } else if (isQr && qrState === 'degraded') {
    apiTone = 'warn';
    apiText = 'временный сбой';
  } else if (isCollector && status?.last_error) {
    apiTone = 'error';
    apiText = 'ошибка';
  } else if (isCollector && status?.stale) {
    apiTone = 'warn';
    apiText = 'данные устарели';
  } else if (fresh?.stale) {
    apiTone = 'warn';
    apiText = 'данные устарели';
  }

  const apiDot = apiTone === 'ok' ? 'bg-verdant' : apiTone === 'warn' ? 'bg-status-warn' : 'bg-ember';
  const statusLabel =
    isQr && qrState === 'reauth_required'
      ? 'Нужно переподключить Telegram'
      : isQr && qrState === 'degraded'
        ? 'Сбор временно недоступен'
        : apiTone === 'ok'
          ? 'Данные актуальны'
          : apiTone === 'warn'
            ? 'Данные устарели'
            : 'Ошибка сбора';
  const connectionLink = isQr
    ? qrState === 'reauth_required'
      ? '/connect?source=telegram&tab=qr&action=reconnect'
      : '/connect?source=telegram&tab=qr'
    : isCollector
      ? '/connect?source=telegram&tab=agent'
      : null;
  const connectionLabel = isQr && qrState === 'reauth_required'
    ? 'Переподключить Telegram →'
    : isQr
      ? 'Открыть подключение →'
      : 'Настроить collector →';

  return (
    <div>
      {/* One-line status by default (all breakpoints) — the full Источник/Сборщик/API table is one
          click away, not on the first level. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-sm"
      >
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${apiDot}`} />
        <span className="min-w-0 truncate text-ink2">
          {statusLabel}
          <span className="text-ink3"> · обновлено {lastCollect}</span>
        </span>
        <Icon name="chevron" className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-ink3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-3 max-w-sm">
          <Row label="Источник" value={source} />
          <Row label="Последний сбор" value={lastCollect} />
          <Row label="Режим сбора" value={collectionMode} />
          <Row label="API" value={apiText} tone={apiTone} />
          {connectionLink && (
            <Link to={connectionLink} className="mt-3 inline-block text-sm font-medium text-primary hover:underline">
              {connectionLabel}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
