import animate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1.5rem', screens: { '2xl': '1200px' } },
    extend: {
      fontFamily: {
        // Inter for everything; Roboto Mono is scoped (timestamps / collector version / API status).
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Roboto Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Canonical type scale ("Atlavue Refined Technical") — ONE ladder, no magic `text-[Npx]`.
      // Hierarchy comes from size + ink shade, not weight (we ship only 400/500). Keep ≲4 steps on
      // a single screen. Native Tailwind steps are left untouched; we add only the two ends (2xs, hero).
      //   text-2xs  11 — meta: timestamps · API/collector status · axis ticks · micro-labels
      //   text-xs   12 — caption: sublabels · secondary muted · table meta            (native)
      //   text-sm   14 — body: default text · table cells · most UI                   (native)
      //   text-base 16 — emphasis: channel/brand name · card titles · section leads   (native)
      //   text-lg   18 — sub-heading  [intermediate — use sparingly, don't stack]     (native)
      //   text-2xl  24 — title: page & modal headings                                 (native)
      //   text-3xl  30 — secondary metric [intermediate — Mentions / IG KPI numbers]  (native)
      //   text-hero 44 — primary KPI hero (Views · Subscribers)
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '0.9375rem' }],
        hero: ['2.75rem', { lineHeight: '1' }],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        // Warm ink scale (secondary / tertiary text) + status tints (badge / section backgrounds).
        ink2: 'hsl(var(--ink2))',
        ink3: 'hsl(var(--ink3))',
        'amber-tint': 'hsl(var(--amber-tint))',
        'green-tint': 'hsl(var(--green-tint))',
        'blue-tint': 'hsl(var(--blue-tint))',
        'hover-row': 'hsl(var(--hover-row))',
        avatar: 'hsl(var(--avatar))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        // Brand chart/data accents (raw HSL channels consumed via hsl(var(--…))).
        iris: { DEFAULT: 'hsl(var(--brand-iris))', soft: 'hsl(var(--brand-iris-soft))' },
        verdant: 'hsl(var(--brand-verdant))',
        ember: 'hsl(var(--brand-ember))',
        'ember-strong': 'hsl(var(--brand-ember-strong))',
        'status-warn': 'hsl(var(--status-warn))',
        // Categorical data-viz series (distinct from the brand accents; see index.css --chart-*).
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
          6: 'hsl(var(--chart-6))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [animate],
};
