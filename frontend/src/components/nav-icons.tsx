import type { SVGProps } from 'react';

/** Minimal inline icon set (Lucide-style, stroke + currentColor) for the sidebar shell.
    No icon dependency — keeps the bundle + CSP simple. */
const PATHS = {
  overview: ['M3 3h8v8H3z', 'M13 3h8v8h-8z', 'M13 13h8v8h-8z', 'M3 13h8v8H3z'],
  analytics: ['M3 21h18', 'M7 21V10', 'M12 21V4', 'M17 21v-7'],
  charts: ['M3 3v18h18', 'm7 14 3-3 3 3 5-6'],
  posts: ['M4 6h16', 'M4 12h16', 'M4 18h10'],
  mentions: ['M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0z', 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8'],
  audience: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  stories: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'm10 8.5 5 3.5-5 3.5z'],
  settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M2 14h4', 'M10 8h4', 'M18 16h4'],
  admin: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  bugs: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 8v4', 'M12 16h.01'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'm21 21-4.35-4.35'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  chevron: ['m6 9 6 6 6-6'],
  calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v2', 'M12 21v2', 'm4.2 4.2 1.4 1.4', 'm18.4 18.4 1.4 1.4', 'M1 12h2', 'M21 12h2', 'm4.2 19.8 1.4-1.4', 'm18.4 5.6 1.4-1.4'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 8h.01', 'M12 11v5'],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {PATHS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
