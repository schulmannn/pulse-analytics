import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useChannels, useCollectorStatus, useHistory } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { freshness, latestHistoryDay } from '@/lib/freshness';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/nav-icons';

/**
 * "Состояние данных" — the data-health block (Figma Overview, right column). A small label + a
 * hairline-delimited row set (Источник / Последний сбор / Сборщик / API) with technical readouts in
 * scoped Roboto Mono, and a "Настроить сбор →" link. Central channels are live MTProto; collector
 * channels read /collector-status (version, last success, errors).
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
  const { data: collector } = useCollectorStatus(isCentral || !current ? null : current.id);
  const { data: history } = useHistory(730);
  const fresh = freshness(latestHistoryDay(history), Date.now());

  const status = collector?.status;
  const source = isCentral ? 'Telegram · MTProto' : 'Telegram · Collector';
  const lastCollect = status?.last_success_at ? fmt.date(status.last_success_at) : fresh?.label ?? '—';
  const collectorVer = status?.collector_version ? `v${status.collector_version}` : isCentral ? 'MTProto' : '—';

  // API/health tone: collector error → error; stale → warn; otherwise ok.
  let apiTone: 'ok' | 'warn' | 'error' = 'ok';
  let apiText = '200 OK';
  if (!isCentral && status?.last_error) {
    apiTone = 'error';
    apiText = 'ошибка';
  } else if (!isCentral && status?.stale) {
    apiTone = 'warn';
    apiText = 'данные устарели';
  } else if (fresh?.stale) {
    apiTone = 'warn';
    apiText = 'данные устарели';
  }

  const apiDot = apiTone === 'ok' ? 'bg-verdant' : apiTone === 'warn' ? 'bg-status-warn' : 'bg-ember';
  const statusLabel = apiTone === 'ok' ? 'Данные актуальны' : apiTone === 'warn' ? 'Данные устарели' : 'Ошибка сбора';

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
          <Row label="Сборщик" value={collectorVer} />
          <Row label="API" value={apiText} tone={apiTone} />
          {/* «Подключить источник», не «Настроить сбор»: эта ссылка ведёт на /connect (хаб
              подключений), а «Настроить сбор» в Настройках → Данные — соседняя строка в раздел
              «Каналы». Один лейбл на двух разных назначениях в одной панели путал (проход №3). */}
          <Link to="/connect" className="mt-3 inline-block text-sm font-medium text-primary hover:underline">
            Подключить источник →
          </Link>
        </div>
      )}
    </div>
  );
}
