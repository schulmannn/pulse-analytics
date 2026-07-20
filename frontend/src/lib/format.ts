// Formatting helpers ported verbatim from the legacy dashboard so migrated panels
// render identical strings. Russian locale; thin no-break space as thousands sep.

/**
 * Parse a bare calendar-day key ("YYYY-MM-DD") as LOCAL midnight. `new Date('YYYY-MM-DD')`
 * is UTC midnight, and rendering that locally shows the PREVIOUS day to any viewer west of
 * UTC (D6.5). A day key names a calendar date, not an instant — it must read the same in
 * every timezone. Full ISO timestamps are NOT day keys and keep instant semantics.
 */
/** Русская плюрализация: pluralRu(5, ['пост', 'поста', 'постов']) → «постов». Живёт здесь
 *  (нижний слой без зависимостей), чтобы аггрегаторы не тянули resolveWidgetMetric циклом;
 *  resolveWidgetMetric ре-экспортирует для старых импортёров. */
/** Метка дня из API-ключа «dd.mm» → канонный вид fmt.day («3 июл.»). Год фиктивный високосный
 *  (2000) — рендерится только день+месяц; не-ключи возвращаются как есть. */
export function ddmmDay(key: string): string {
  const m = /^(\d{2})\.(\d{2})$/.exec(key);
  return m ? fmt.day(`2000-${m[2]}-${m[1]}`) : key;
}

export function pluralRu(n: number, forms: [one: string, few: string, many: string]): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (d === 1) return forms[0];
  if (d >= 2 && d <= 4) return forms[1];
  return forms[2];
}

export function parseDayKey(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

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
  /** Headline KPI number: full with grouped thousands below 10 000 («4 749»), compact from
      10 000 up («12.6k»). ONE rule for every card headline so sibling cards never mix
      registers (steep's threshold); tooltips, tables and axes keep fmt.num. */
  kpi(n?: number | null): string {
    if (n == null || isNaN(n)) return '—';
    return Math.abs(n) >= 1e4 ? fmt.short(n) : fmt.num(n);
  },
  /** Signed percentage (+12.34%). */
  pct(p?: number | null, digits = 2): string {
    if (p == null || isNaN(p)) return '—';
    return (p >= 0 ? '+' : '') + p.toFixed(digits) + '%';
  },
  /**
   * Short localized day ("5 июн."). A "YYYY-MM-DD" archive key renders as that calendar
   * date in every timezone; an ISO timestamp / Date / epoch-ms renders as the viewer's
   * local day of that instant.
   */
  day(v?: string | number | Date | null): string {
    if (v == null || v === '') return '';
    try {
      const d = typeof v === 'string' ? (parseDayKey(v) ?? new Date(v)) : new Date(v);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    } catch {
      return '';
    }
  },
  /** Localized date + time ("5 июн., 14:30"). A bare day key has no instant — no time part. */
  date(iso?: string | null): string {
    if (!iso) return '';
    if (parseDayKey(iso)) return fmt.day(iso);
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
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

// ── Russian localisation for API-shaped chart strings ────────────────────────────────────────
// The Telegram graphs pipeline delivers English month tokens ("18 May", "24 Jun 21:00") and
// English series names ("Views", "Shares") verbatim; these two helpers keep the Russian UI
// Russian without touching the numeric payloads.

/** English 3-letter month token → Russian genitive short form (axis-label style). */
const RU_MONTH: Record<string, string> = {
  Jan: 'янв', Feb: 'фев', Mar: 'мар', Apr: 'апр', May: 'мая', Jun: 'июн',
  Jul: 'июл', Aug: 'авг', Sep: 'сен', Oct: 'окт', Nov: 'ноя', Dec: 'дек',
};

/**
 * Translate the 12 English month tokens inside a pre-formatted axis label to Russian,
 * preserving everything else: "24 Jun 21:00" → "24 июн 21:00", "18 May" → "18 мая".
 * Unknown/already-Russian labels pass through unchanged.
 */
export function ruAxisLabel(label: string): string {
  if (!label) return label;
  return label.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, (m) => RU_MONTH[m] ?? m);
}

/** English series names the graphs API ships as-is → Russian UI names (lowercased keys). */
const RU_SERIES: Record<string, string> = {
  views: 'Просмотры',
  shares: 'Репосты',
  forwards: 'Репосты',
  followers: 'Подписчики',
  subscribers: 'Подписчики',
  reactions: 'Реакции',
  comments: 'Комментарии',
  joined: 'Подписались',
  left: 'Отписались',
};

/** Russian name for an API-provided series ("Views" → "Просмотры"); fallback = the original. */
export function ruSeriesName(name?: string | null): string {
  const raw = (name ?? '').trim();
  if (!raw) return '';
  return RU_SERIES[raw.toLowerCase()] ?? raw;
}

/**
 * A smooth cubic SVG path whose control points stay inside every adjacent pair's y-range.
 * `precision` keeps tiny/custom viewBox paths compact while full-size charts can retain exact
 * measured coordinates.
 */
export function smoothSvgPath(
  points: ReadonlyArray<{ x: number; y: number }>,
  precision?: number,
): string {
  const first = points[0];
  if (!first) return '';
  const format = (value: number) => precision == null ? String(value) : value.toFixed(precision);
  const point = ({ x, y }: { x: number; y: number }) => `${format(x)},${format(y)}`;
  let path = `M${point(first)}`;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const current = points[i];
    const middleX = (previous.x + current.x) / 2;
    path += ` C${format(middleX)},${format(previous.y)} ${format(middleX)},${format(current.y)} ${point(current)}`;
  }
  return path;
}

/**
 * Sparkline SVG path for a value series (viewBox 200×32) as a NON-OVERSHOOTING smooth cubic —
 * the same principle LineChart uses: horizontal control handles at each segment's midpoint keep
 * the curve inside that pair's [prev, curr] range, so a tiny trend line never invents a peak
 * above its maximum or a dip below its minimum, and the endpoints stay exact.
 */
export function sparkPath(values: number[]): string {
  if (!values || values.length === 0) return '';
  const w = 200, h = 32, pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = (w - pad * 2) / Math.max(values.length - 1, 1);
  const px = (i: number) => pad + i * step;
  const py = (v: number) => h - pad - ((v - min) / range) * (h - pad * 2);
  return smoothSvgPath(values.map((value, index) => ({ x: px(index), y: py(value) })), 1);
}

/** Closed area variant of {@link sparkPath} for the soft fill underneath. */
export function sparkAreaPath(values: number[]): string {
  if (!values || values.length === 0) return '';
  return `${sparkPath(values)} L200,32 L0,32 Z`;
}
