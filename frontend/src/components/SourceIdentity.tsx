import { useChannels } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { cn } from '@/lib/utils';
import { NetworkGlyph, networkByKey } from '@/lib/networks';
import type { SourceNetwork } from '@/lib/homeSourceContext';

/**
 * Compact desktop-only source identity. Feed pages use it once in the page header; Home cards use
 * it per widget because a personal board may mix networks and pinned channels.
 */
export function SourceIdentity({
  network,
  channelId,
  compact = false,
  className,
}: {
  network: SourceNetwork;
  channelId?: number | null;
  /** Third-width Home cards keep only the network badge so the metric title stays readable. */
  compact?: boolean;
  className?: string;
}) {
  const { channelId: selectedChannelId } = useSelectedChannel();
  const { data } = useChannels();
  const effectiveChannelId = channelId ?? selectedChannelId;
  const channel = data?.channels.find((item) => item.id === effectiveChannelId);
  const channelLabel = channel?.username
    ? `@${channel.username}`
    : channel?.title || (effectiveChannelId != null ? `#${effectiveChannelId}` : 'источник');
  const networkLabel = network === 'multi' ? 'Telegram + Instagram' : networkByKey(network).name;
  const fullLabel = `${networkLabel} · ${channelLabel}`;
  const shortLabel = network === 'multi' ? 'TG + IG' : network.toUpperCase();

  return (
    <span
      className={cn(
        'hidden min-w-0 max-w-52 items-center gap-1.5 text-2xs text-muted-foreground md:inline-flex',
        compact && 'max-w-none',
        className,
      )}
      data-source-identity
      aria-label={compact ? fullLabel : undefined}
      title={fullLabel}
    >
      {network === 'multi' ? (
        <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
          {(['tg', 'ig'] as const).map((key) => (
            <span key={key} style={{ color: networkByKey(key).color }}>
              <NetworkGlyph k={key} className="h-3 w-3" />
            </span>
          ))}
        </span>
      ) : (
        <span className="shrink-0" style={{ color: networkByKey(network).color }} aria-hidden="true">
          <NetworkGlyph k={network} className="h-3 w-3" />
        </span>
      )}
      <span className="truncate" aria-hidden={compact || undefined}>
        {compact ? shortLabel : `${networkLabel} · ${channelLabel}`}
      </span>
    </span>
  );
}
