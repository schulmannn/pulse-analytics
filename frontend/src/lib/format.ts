// Formatting helpers ported verbatim from the legacy dashboard so migrated panels
// render identical strings. Russian locale; thin no-break space as thousands sep.

/** Русская плюрализация: pluralRu(5, ['пост', 'поста', 'постов']) → «постов». Живёт здесь
 *  (нижний слой без зависимостей), чтобы аггрегаторы не тянули resolveWidgetMetric циклом;
 *  resolveWidgetMetric ре-экспортирует для старых импортёров. */
export function pluralRu(n: number, forms: [one: string, few: string, many: string]): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (d === 1) return forms[0];
  if (d >= 2 && d <= 4) return forms[1];
  return forms[2];
}

/**
 * Parse a bare calendar-day key ("YYYY-MM-DD") as LOCAL midnight. `new Date('YYYY-MM-DD')`
 * is UTC midnight, and rendering that locally shows the PREVIOUS day to any viewer west of
 * UTC (D6.5). A day key names a calendar date, not an instant — it must read the same in
 * every timezone. Full ISO timestamps are NOT day keys and keep instant semantics.
 */
// Английские аббревиатуры месяцев для оси длинных окон (владелец, 2026-08-14: латиница ок).
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Ключ оси (day-key строка, ms-таймстамп или полный ISO) → Date; не-дневные строковые корзины
    (месяц «2026-05», квартал, год) отсекаются — у них нет ни дня недели, ни первой точки месяца. */
function axisKeyToDate(v: string | number | null | undefined): Date | null {
  if (v == null || v === '') return null;
  const d =
    typeof v === 'number'
      ? new Date(v)
      : parseDayKey(v) ?? (v.length > 10 ? new Date(v) : null);
  return d != null && !isNaN(d.getTime()) ? d : null;
}

/**
 * Общее ядро временно́й оси (канон 2026-08-14, три режима по длине окна):
 *  - ≤ 8 дней и ≤ 8 точек — латинские буквы дней недели (M T W T F S S) на каждой точке;
 *  - ≥ 90 дней — РАЗРЕЖЕННАЯ ось английских месяцев: аббревиатура у первой точки каждого
 *    месяца, '' между тиками; тиков ≤ 8 — шаг по месяцам считается ОТ ТЕКУЩЕГО назад, так что
 *    последняя метка (на ней пилюля «сейчас») живёт всегда;
 *  - между порогами — undefined, ось остаётся датами.
 * Порог по ОКНУ у букв обязателен: разреженный ряд из 5 точек в 30-дневном окне нёс бы два
 * разных понедельника с одинаковой «M».
 */
function timeAxisCore(
  dates: Array<Date | null>,
  windowDays: number,
  opts?: { monthsOnly?: boolean },
): string[] | undefined {
  if (dates.length < 2 || !dates.every((d) => d != null)) return undefined;
  if (windowDays <= 0) return undefined;
  // monthsOnly — для НЕДЕЛЬНЫХ корзин: их ключ (понедельник) имеет честный месяц, но буква дня
  // у корзины лгала бы («M» про целую неделю), поэтому режим букв для них выключен.
  if (!opts?.monthsOnly && windowDays <= 8 && dates.length <= 8) {
    return dates.map((d) => ['S', 'M', 'T', 'W', 'T', 'F', 'S'][(d as Date).getDay()] ?? '');
  }
  if (windowDays < 90) return undefined;
  // Первая точка каждого календарного месяца (включая частичный месяц на кромке окна).
  const monthStarts: number[] = [];
  let prevKey = '';
  dates.forEach((d, i) => {
    const key = `${(d as Date).getFullYear()}-${(d as Date).getMonth()}`;
    if (key !== prevKey) {
      monthStarts.push(i);
      prevKey = key;
    }
  });
  if (monthStarts.length < 2) return undefined;
  const MAX_TICKS = 8;
  const step = Math.ceil(monthStarts.length / MAX_TICKS);
  const kept = new Set<number>();
  for (let k = monthStarts.length - 1; k >= 0; k -= step) kept.add(monthStarts[k]);
  const out = dates.map(() => '');
  for (const i of kept) out[i] = MONTH_EN[(dates[i] as Date).getMonth()] ?? '';
  return out.some((t) => t.length > 0) ? out : undefined;
}

/**
 * Временна́я ось по ИЗВЕСТНОМУ окну (строители, у которых windowDays под рукой — kpiDerive,
 * igWindowMetrics): ≤ 8 дней → буквы дней недели, ≥ 90 → английские месяцы, между — даты.
 */
export function timeAxisLabels(
  dayKeys: string[],
  windowDays: number | null | undefined,
): string[] | undefined {
  if (windowDays == null) return undefined;
  const dates = dayKeys.map(axisKeyToDate);
  // «Всё» (windowDays = 0) безгранично — окном честно служит размах самой серии: у молодого
  // канала весь архив может быть неделей (буквы честны), у взрослого — годами (месяцы).
  if (windowDays === 0) {
    const first = dates[0];
    const last = dates[dates.length - 1];
    if (!first || !last) return undefined;
    return timeAxisCore(dates, Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1);
  }
  return timeAxisCore(dates, windowDays);
}

export interface TimeAxisOpts {
  /** Только режим месяцев (недельные корзины: буква дня у корзины лгала бы). */
  monthsOnly?: boolean;
}

/**
 * Временна́я ось по РАЗМАХУ самих ключей — для поверхностей без точного окна: у оконных серий
 * размах практически равен окну. Ключи — day-key строки, ms-таймстампы или полные ISO; недельные
 * корзины проходят (их ключ — понедельник, месяц у него честный), месячные/квартальные отсекает
 * axisKeyToDate → ось остаётся датами.
 */
export function timeAxisFromDayKeys(
  dayKeys: Array<string | number | null | undefined>,
  opts?: TimeAxisOpts,
): string[] | undefined {
  if (dayKeys.length < 2) return undefined;
  const dates = dayKeys.map(axisKeyToDate);
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return undefined;
  const spanDays = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  return timeAxisCore(dates, spanDays, opts);
}

export function parseDayKey(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Epoch-ms КЛЮЧ СОРТИРОВКИ для дневного ключа из API: «YYYY-MM-DD» (точная дата, локальная
 * полночь) или «DD.MM» (год не передан — выводится: месяц, ушедший «вперёд» текущего больше чем
 * на полгода, может быть только прошлогодним, аналитика историческая, декабрь виден из января).
 *
 * ИНВАРИАНТ: дневные разбивки сортируются по ЭТОМУ ключу, а подпись форматируется `fmt.day`
 * уже ПОСЛЕ сортировки. Сортировка по тексту подписи ломается и на «dd.mm» через Новый год,
 * и при любой смене формата подписи. `null` — ключ не распознан (порядок не определён).
 */
export function dayKeyToTs(key: string, now: Date = new Date()): number | null {
  const iso = parseDayKey(key);
  if (iso) return iso.getTime();
  const m = /^(\d{1,2})\.(\d{1,2})$/.exec(key);
  if (!m) return null;
  const month = Number(m[2]) - 1;
  if (month < 0 || month > 11) return null;
  const monthsAhead = (month - now.getMonth() + 12) % 12;
  const year = now.getFullYear() - (monthsAhead > 6 ? 1 : 0);
  return new Date(year, month, Number(m[1])).getTime();
}

export const fmt = {
  /** Full number with grouped thousands (1 234 567). Em-dash for null/NaN. */
  num(n?: number | null): string {
    if (n == null || isNaN(n)) return '—';
    return Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ');
  },
  /**
   * Дробное число с фиксированным числом знаков и разделителем разрядов: «1 234.5».
   *
   * Существует потому, что `toLocaleString('ru-RU')` даёт ЗАПЯТУЮ, и на одном экране рядом
   * оказывались «32,7%» и «↑5.8%» — две системы записи одного и того же (аудит #554, D5).
   * Канон DESIGN_TOKENS — точка, поэтому дробная часть собирается вручную, а разряды берутся
   * у локали и приводятся к неразрывному узкому пробелу.
   */
  numFixed(n?: number | null, digits = 1): string {
    if (n == null || isNaN(n)) return '—';
    const d = Math.max(0, Math.min(6, Math.trunc(digits)));
    // Семантика `maximumFractionDigits`, а НЕ toFixed: хвостовые нули не печатаются. Это ровно то
    // поведение, что было у заменённого toLocaleString — «R 2 дн.», а не «R 2.0 дн.»: здесь
    // меняется только разделитель, а не то, сколько знаков видит человек.
    const fixed = Math.abs(n).toFixed(d).replace(/\.?0+$/, '');
    const [whole, frac] = fixed.split('.');
    const grouped = Number(whole).toLocaleString('ru-RU').replace(/[,\u00a0\u202f ]/g, '\u202f');
    return `${n < 0 ? '−' : ''}${grouped}${frac ? `.${frac}` : ''}`;
  },
  /** Абсолютный процент с фиксированной точностью: «24.6%». Точка, а не запятая (см. numFixed). */
  pctFixed(p?: number | null, digits = 1): string {
    if (p == null || isNaN(p)) return '—';
    return `${fmt.numFixed(p, digits)}%`;
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
   * АБСОЛЮТНЫЙ процент (доля, ER, ERV) с правилом точности: от 1% — один знак («28.9%»), ниже
   * 1% — два («0.42%»), ниже 0.1% — «<0.1%» (там второй знак уже шум измерения, не сигнал).
   * Знаковые ДЕЛЬТЫ форматирует fmt.pct — у них своя роль и обязательный знак.
   */
  pctAbs(p?: number | null): string {
    if (p == null || isNaN(p)) return '—';
    if (p === 0) return '0%';
    const abs = Math.abs(p);
    if (abs < 0.1) return '<0.1%';
    return p.toFixed(abs >= 1 ? 1 : 2) + '%';
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
  /**
   * Однобуквенный день недели для оси КОРОТКОГО окна (≤ 8 дневных точек): Mon=M … Sun=S.
   * Латиница намеренно (владелец, 2026-08-14): русская однобуквенная свёртка неоднозначна —
   * «П» = Пн/Пт, «С» = Ср/Сб/Вс, — а двухбуквенное «Пн» на 7–8 тиках компактной оси толкается.
   * Полную дату при этом обязан называть ховер (тултип), буква несёт только ритм недели.
   */
  weekday(v?: string | number | Date | null): string {
    if (v == null || v === '') return '';
    try {
      const d = typeof v === 'string' ? (parseDayKey(v) ?? new Date(v)) : new Date(v);
      if (isNaN(d.getTime())) return '';
      return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][d.getDay()] ?? '';
    } catch {
      return '';
    }
  },
  /**
   * Тот же канон подписи, но С ГОДОМ («10 июн. 2026 г.») — для границ окон, где год НЕСЁТ СМЫСЛ:
   * окно сравнения может пересекать Новый год, и «22 дек. — 31 дек.» рядом с «1 янв. — 10 янв.»
   * нечем отличить от прошлогоднего. На оси и в тултипе год избыточен — там остаётся `fmt.day`.
   */
  dayYear(v?: string | number | Date | null): string {
    if (v == null || v === '') return '';
    try {
      const d = typeof v === 'string' ? (parseDayKey(v) ?? new Date(v)) : new Date(v);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return '';
    }
  },
  /**
   * Дата и время момента ПО ЧАСТЯМ: «5 июн.» + «14:30». Один разбор на всё приложение —
   * `fmt.date` склеивает их запятой для строки, а таблицы ставят время отдельной строкой под днём
   * (`TwoLineDate`). Раньше двухстрочный вариант резал уже собранную строку по `', '`, и колонка
   * зависела от того, какой разделитель выбрал формат; теперь разделитель — деталь `fmt.date`.
   * Голый дневной ключ («YYYY-MM-DD») не несёт момента, поэтому времени у него нет.
   */
  dateParts(iso?: string | null): { day: string; time: string } {
    if (!iso) return { day: '', time: '' };
    if (parseDayKey(iso)) return { day: fmt.day(iso), time: '' };
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return { day: '', time: '' };
      return {
        day: d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }),
        time: d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      };
    } catch {
      return { day: '', time: '' };
    }
  },
  /** Localized date + time ("5 июн., 14:30"). A bare day key has no instant — no time part. */
  date(iso?: string | null): string {
    const { day, time } = fmt.dateParts(iso);
    return time ? `${day}, ${time}` : day;
  },
  /** Time-of-day greeting. */
  greeting(): string {
    const h = new Date().getHours();
    if (h < 6) return 'Доброй ночи';
    if (h < 12) return 'Доброе утро';
    if (h < 18) return 'Добрый день';
    return 'Добрый вечер';
  },
  /** "Среда · 5 июня" — длинная форма приветствия. Дата берётся у локали (рукописных массивов
      месяцев в приложении нет); руками остаётся только день недели: ru-RU отдаёт его строчным
      («среда»), а строка начинается с заглавной. */
  todayLabel(): string {
    const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
    const d = new Date();
    const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    return `${days[d.getDay()]} · ${date}`;
  },
};

// ── Russian localisation for API-shaped chart strings ────────────────────────────────────────
// The Telegram graphs pipeline delivers English series names ("Views", "Shares") verbatim; this
// helper keeps the Russian UI Russian without touching the numeric payloads. (Axis labels are NOT
// localised from English tokens any more — every date label in the UI is built by `fmt.day`.)

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
