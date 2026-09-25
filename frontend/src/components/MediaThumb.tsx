import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** Decorative media preview with a stable text fallback for missing or failed remote images. */
export function MediaThumb({
  src,
  label = 'Текст',
  className,
}: {
  src?: string | null;
  label?: string;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src && failedSrc !== src);
  const imageRef = useRef<HTMLImageElement>(null);

  // A failed network image is lifecycle state, not a user gesture. Keeping the listener native
  // leaves this decorative thumbnail correctly non-interactive while retaining the text fallback.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image || !src || !showImage) return;
    const handleError = () => setFailedSrc(src);
    image.addEventListener('error', handleError);
    if (image.complete && image.naturalWidth === 0) handleError();
    return () => image.removeEventListener('error', handleError);
  }, [showImage, src]);

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded border border-border/40 bg-muted',
        className,
      )}
    >
      {showImage ? (
        <img
          ref={imageRef}
          loading="lazy"
          src={src!}
          alt=""
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="px-0.5 text-center text-2xs font-medium leading-tight text-muted-foreground">
          {label}
        </span>
      )}
    </span>
  );
}
