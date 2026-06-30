import { Link } from 'react-router-dom';
import { useCollectorStatus } from '@/api/queries';
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

function StatusRow({ tone, text, cta, compact }: { tone: Tone; text: string; cta?: boolean; compact?: boolean }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', compact ? 'text-xs' : 'text-[13px]')}>
      <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', DOT[tone])} />
      <span className={cn('min-w-0 break-words', TEXT[tone])}>{text}</span>
      {cta && !compact && (
        <Link to="/connect" className="shrink-0 font-medium text-primary hover:underline">
          Подробнее →
        </Link>
      )}
    </span>
  );
}

/**
 * Source health line for a channel. 'central' channels are live (Telegram MTProto). Collector
 * channels read the (previously React-unused) /collector-status endpoint and follow the legacy
 * precedence: no data → error → stale → healthy. `compact` drops the CTA for inline use
 * (Hero/cards); the full form links to /connect for setup/troubleshooting.
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
  // Only collector channels have a collector-status row; skip the request for central.
  const { data, isLoading, isError } = useCollectorStatus(isCentral ? null : channelId);

  if (isCentral) return <StatusRow tone="ok" text="Живой источник — Telegram (MTProto)" compact={compact} />;
  if (isLoading) return <StatusRow tone="muted" text="Проверяем сборщик…" compact={compact} />;
  if (isError) return <StatusRow tone="muted" text="Статус сборщика недоступен" compact={compact} />;

  const status = data?.status;
  if (!status) return <StatusRow tone="muted" text="Данных ещё нет — запустите сборщик" cta compact={compact} />;
  if (status.last_error) return <StatusRow tone="error" text={`Ошибка сборщика: ${status.last_error}`} cta compact={compact} />;
  if (status.stale) {
    const hrs = status.stale_after_hours;
    return <StatusRow tone="warn" text={`Сборщик молчит дольше ${hrs ?? ''} ч`} cta compact={compact} />;
  }
  const when = status.last_success_at ? fmt.date(status.last_success_at) : '—';
  const ver = status.collector_version ? ` · v${status.collector_version}` : '';
  return <StatusRow tone="ok" text={`Последний сбор: ${when}${ver}`} compact={compact} />;
}
