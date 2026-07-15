import { Link } from 'react-router-dom';
import { useCollectorStatus, useTgQrStatus } from '@/api/queries';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';

type Tone = 'ok' | 'warn' | 'error' | 'muted';

const DOT: Record<Tone, string> = {
  ok: 'bg-verdant',
  warn: 'bg-status-warn',
  error: 'bg-ember',
  muted: 'bg-muted-foreground/50',
};
const TEXT: Record<Tone, string> = {
  ok: 'text-muted-foreground',
  warn: 'text-status-warn',
  error: 'text-ember-strong',
  muted: 'text-muted-foreground',
};

function StatusRow({
  tone,
  text,
  cta,
  compact,
  monoSuffix,
}: {
  tone: Tone;
  text: string;
  cta?: { to: string; label: string };
  compact?: boolean;
  /** Technical readout (timestamp / collector version) rendered in Roboto Mono. */
  monoSuffix?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', compact ? 'text-xs' : 'text-sm')}>
      <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', DOT[tone])} />
      <span className={cn('min-w-0 break-words', TEXT[tone])}>
        {text}
        {monoSuffix && <span className="font-mono tabular-nums text-ink3">{monoSuffix}</span>}
      </span>
      {cta && !compact && (
        <Link to={cta.to} className="shrink-0 font-medium text-primary hover:underline">
          {cta.label}
        </Link>
      )}
    </span>
  );
}

/**
 * Source health line for a channel. Managed QR health is user-scoped and comes from the shared
 * session-status query; external collectors keep their per-channel status. `compact` drops the CTA
 * for inline use, while settings links directly to the repair surface for that source.
 */
export function SourceStatus({
  channelId,
  source,
  compact = false,
}: {
  channelId: number;
  source?: string | null;
  compact?: boolean;
}) {
  const isCentral = source === 'central';
  const isIg = source === 'ig';
  const isQr = source === 'qr';
  const isCollector = source === 'collector' || source == null;
  // QR health belongs to the user's managed session; external collectors keep their per-channel row.
  const { data, isLoading, isError } = useCollectorStatus(isCollector ? channelId : null);
  const qr = useTgQrStatus(isQr);

  if (isCentral) return <StatusRow tone="ok" text="Живой источник — Telegram (MTProto)" compact={compact} />;
  if (isIg) return <StatusRow tone="ok" text="Instagram-источник — данные идут по OAuth" compact={compact} />;
  if (isQr) {
    if (qr.isLoading) return <StatusRow tone="muted" text="Проверяем Telegram-подключение…" compact={compact} />;
    if (qr.isError) return <StatusRow tone="muted" text="Статус Telegram-подключения недоступен" compact={compact} />;
    if (qr.data?.connection_state === 'reauth_required') {
      return (
        <StatusRow
          tone="error"
          text="Сессия Telegram недействительна"
          cta={{ to: '/connect?source=telegram&tab=qr&action=reconnect', label: 'Переподключить →' }}
          compact={compact}
        />
      );
    }
    if (qr.data?.connection_state === 'degraded') {
      return <StatusRow tone="warn" text="Telegram временно недоступен — повторим автоматически" compact={compact} />;
    }
    const when = qr.data?.last_success_at ? fmt.date(qr.data.last_success_at) : 'подключён';
    return <StatusRow tone="ok" text="Telegram: " monoSuffix={when} compact={compact} />;
  }
  if (isLoading) return <StatusRow tone="muted" text="Проверяем сборщик…" compact={compact} />;
  if (isError) return <StatusRow tone="muted" text="Статус сборщика недоступен" compact={compact} />;

  const status = data?.status;
  if (!status) {
    return (
      <StatusRow
        tone="muted"
        text="Данных ещё нет — запустите сборщик"
        cta={{ to: '/connect?source=telegram&tab=agent', label: 'Настроить →' }}
        compact={compact}
      />
    );
  }
  if (status.last_error) {
    return (
      <StatusRow
        tone="error"
        text={`Ошибка сборщика: ${status.last_error}`}
        cta={{ to: '/connect?source=telegram&tab=agent', label: 'Проверить →' }}
        compact={compact}
      />
    );
  }
  if (status.stale) {
    const hrs = status.stale_after_hours;
    return (
      <StatusRow
        tone="warn"
        text={`Сборщик молчит дольше ${hrs ?? ''} ч`}
        cta={{ to: '/connect?source=telegram&tab=agent', label: 'Проверить →' }}
        compact={compact}
      />
    );
  }
  const when = status.last_success_at ? fmt.date(status.last_success_at) : '—';
  const ver = status.collector_version ? ` · v${status.collector_version}` : '';
  return <StatusRow tone="ok" text="Последний сбор: " monoSuffix={`${when}${ver}`} compact={compact} />;
}
