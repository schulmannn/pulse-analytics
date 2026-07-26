import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

// The MTProto photo endpoint serves the single configured ('central') channel, so it's only
// requested for that channel; everything else falls back to the initial.
const PHOTO_URL = '/api/tg/mtproto/channel/photo';

interface ChannelAvatarProps {
  /** 'central' channels have a live MTProto session and therefore a real profile photo. */
  source?: string | null;
  /** Single-letter fallback shown for collector channels or on any photo error. */
  initial: string;
  /** Identity tint for the letter chip — a `.chip-tint-N` bg/ink pair (see index.css),
      picked deterministically from the channel name. Defaults to the brand-blue chip. */
  tintClassName?: string;
  /** Sizing + radius + text-size utilities, e.g. "h-12 w-12 rounded-xl text-lg". */
  className?: string;
}

/**
 * Channel identity glyph. For the 'central' channel it shows the real Telegram profile photo;
 * on any load error — or for collector channels with no live session — it falls back to the
 * initial on a brand-tinted squircle (the previous look). Graceful: if the MTProto service is
 * down or the channel has no photo, the image load listener quietly swaps in the initial.
 */
export function ChannelAvatar({ source, initial, tintClassName, className }: ChannelAvatarProps) {
  const canPhoto = source === 'central';
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  // Reset the error gate when switching channels so a new 'central' channel retries the photo.
  useEffect(() => setFailed(false), [source]);
  // `error` is a media lifecycle event, not user interaction. Register it on the DOM node instead
  // of making the passive <img> look interactive to accessibility tooling. The `complete` check
  // covers a cached failure that finished before the layout effect ran.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const handleError = () => setFailed(true);
    image.addEventListener('error', handleError);
    if (image.complete && image.naturalWidth === 0) handleError();
    return () => image.removeEventListener('error', handleError);
  }, [canPhoto, failed]);

  if (canPhoto && !failed) {
    return (
      <img
        ref={imageRef}
        src={PHOTO_URL}
        alt=""
        referrerPolicy="no-referrer"
        className={cn('shrink-0 bg-muted object-cover', className)}
      />
    );
  }
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center font-medium',
        tintClassName ?? 'bg-primary text-primary-foreground',
        className,
      )}
    >
      {initial}
    </span>
  );
}
