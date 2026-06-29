import type { SVGProps } from 'react';

/**
 * The Pulse brand mark — an analytics pulse/waveform line (replaces the "P" monogram, which
 * read as a generator placeholder). Inherits color via currentColor; no dependency.
 */
export function PulseMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M2 12h4l3-7 4 14 3-8h6" />
    </svg>
  );
}
