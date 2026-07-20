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
  className,
}: {
  network: SourceNetwork;
  channelId?: number | null;
  className?: string;
}) {
  const { channelId: selectedChannelId } = useSelectedChannel();
  const { data } = useChannels();
  const effectiveChannelId = channelId ?? selectedChannelId;
  const channel = data?.channels.find((item) => item.id === effectiveChannelId);
  const channelLabel = channel?.username
    ? `@${channel.username}`
    : channel?.title || (effectiveChannelId != null ? `#${effectiveChannelId}` : 'источник');

  return (
    <span
      className={cn(
        'hidden min-w-0 max-w-44 items-center gap-1.5 rounded-md border border-border/80 bg-background/65 px-2 py-1 text-2xs font-medium text-muted-foreground shadow-sm backdrop-blur md:inline-flex',
        className,
      )}
      data-source-identity
      title={`${network === 'multi' ? 'Telegram + Instagram' : networkByKey(network).name} · ${channelLabel}`}
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
          <NetworkGlyph k={network} className="h-3.5 w-3.5" />
        </span>
      )}
      <span className="truncate">
        {network === 'multi' ? 'TG + IG' : networkByKey(network).name} · {channelLabel}
      </span>
    </span>
  );
}
