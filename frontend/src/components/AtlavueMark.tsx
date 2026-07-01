import type { SVGProps } from 'react';

/**
 * The Atlavue brand mark — three stacked, ascending layers (atlas strata / data rows). The tiers
 * step down in opacity for depth; color comes from `currentColor`, so it inherits the accent (or
 * ink) of whatever it sits in. No dependency.
 */
export function AtlavueMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <rect x="8.5" y="5.4" width="7" height="3.4" rx="1.7" />
      <rect x="5.5" y="10.3" width="13" height="3.4" rx="1.7" opacity="0.6" />
      <rect x="2.5" y="15.2" width="19" height="3.4" rx="1.7" opacity="0.32" />
    </svg>
  );
}
