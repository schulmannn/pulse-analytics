import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

// The MTProto photo endpoint serves the single configured ('central') channel, so it's only
// requested for that channel; everything else falls back to the initial.
const PHOTO_URL = '/api/tg/mtproto/channel/photo';

interface ChannelAvatarProps {
  /** 'central' channels have a live MTProto session and therefore a real profile photo. */
  source?: string | null;
  /** Single-letter fallback shown for collector channels or on any photo error. */
  initial: string;
  /** Sizing + radius + text-size utilities, e.g. "h-12 w-12 rounded-xl text-lg". */
  className?: string;
}

/**
 * Channel identity glyph. For the 'central' channel it shows the real Telegram profile photo;
 * on any load error — or for collector channels with no live session — it falls back to the
 * initial on a brand-tinted squircle (the previous look). Graceful: if the MTProto service is
 * down or the channel has no photo, the <img> onError quietly swaps in the initial.
 */
export function ChannelAvatar({ source, initial, className }: ChannelAvatarProps) {
  const canPhoto = source === 'central';
  const [failed, setFailed] = useState(false);
  // Reset the error gate when switching channels so a new 'central' channel retries the photo.
  useEffect(() => setFailed(false), [source]);

  if (canPhoto && !failed) {
    return (
      <img
        src={PHOTO_URL}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn('shrink-0 bg-muted object-cover', className)}
      />
    );
  }
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center bg-primary font-medium text-primary-foreground',
        className,
      )}
    >
      {initial}
    </span>
  );
}
