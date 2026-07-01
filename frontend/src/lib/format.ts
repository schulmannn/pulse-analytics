// Formatting helpers ported verbatim from the legacy dashboard so migrated panels
// render identical strings. Russian locale; thin no-break space as thousands sep.

export const fmt = {
  /** Full number with grouped thousands (1 234 567). Em-dash for null/NaN. */
  num(n?: number | null): string {
    if (n == null || isNaN(n)) return '—';
    return Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ');
  },
  /** Compact number (1.2k / 3.4M). */
  short(n?: number | null): string {
    if (n == null || isNaN(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'k';
    return String(Math.round(n));
  },
  /** Signed percentage (+12.34%). */
  pct(p?: number | null, digits = 2): string {
    if (p == null || isNaN(p)) return '—';
    return (p >= 0 ? '+' : '') + p.toFixed(digits) + '%';
  },
  /** Short localized day ("5 июн."). Accepts an ISO date or a "YYYY-MM-DD" archive key. */
  day(iso?: string | null): string {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    } catch {
      return '';
    }
  },
  /** Localized date + time ("5 июн., 14:30"). */
  date(iso?: string | null): string {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return (
        d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) +
        ', ' +
        d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      );
    } catch {
      return '';
    }
  },
  /** Time-of-day greeting. */
  greeting(): string {
    const h = new Date().getHours();
    if (h < 6) return 'Доброй ночи';
    if (h < 12) return 'Доброе утро';
    if (h < 18) return 'Добрый день';
    return 'Добрый вечер';
  },
  /** "Среда · 5 июня" */
  todayLabel(): string {
    const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
    const months = [
      'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
      'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
    ];
    const d = new Date();
    return `${days[d.getDay()]} · ${d.getDate()} ${months[d.getMonth()]}`;
  },
};

/** Sparkline SVG path for a value series (viewBox 200×32). */
export function sparkPath(values: number[]): string {
  if (!values || values.length === 0) return '';
  const w = 200, h = 32, pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = (w - pad * 2) / Math.max(values.length - 1, 1);
  return values
    .map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** Closed area variant of {@link sparkPath} for the soft fill underneath. */
export function sparkAreaPath(values: number[]): string {
  if (!values || values.length === 0) return '';
  return `${sparkPath(values)} L200,32 L0,32 Z`;
}
