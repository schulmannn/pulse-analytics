import { describe, expect, it } from 'vitest';
import { dayKeyToTs, fmt, parseDayKey, ruSeriesName, sparkAreaPath, sparkPath, timeAxisFromDayKeys, timeAxisLabels } from '@/lib/format';

describe('parseDayKey', () => {
  it('parses a bare day key as LOCAL midnight of that calendar date', () => {
    const d = parseDayKey('2026-06-30');
    expect(d).not.toBeNull();
    // TZ-independent by construction: local components must equal the key's digits,
    // whatever zone the test host runs in (new Date('2026-06-30') would give 29 June
    // local components anywhere west of UTC — the D6.5 minus-one-day bug).
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(5);
    expect(d!.getDate()).toBe(30);
    expect(d!.getHours()).toBe(0);
  });

  it('rejects anything that is not a bare YYYY-MM-DD', () => {
    expect(parseDayKey('2026-06-30T12:00:00Z')).toBeNull();
    expect(parseDayKey('30.06')).toBeNull();
    expect(parseDayKey('')).toBeNull();
  });
});

describe('fmt.day / fmt.date timezone semantics', () => {
  it('renders a day key as its own calendar date in every timezone', () => {
    expect(fmt.day('2026-06-30')).toBe('30 июн.');
    expect(fmt.day('2026-01-01')).toBe('1 янв.');
  });

  it('renders an instant (Date / epoch-ms) as the local day of that instant', () => {
    const instant = new Date(2026, 5, 30, 15, 0); // local 30 June, 15:00
    expect(fmt.day(instant)).toBe('30 июн.');
    expect(fmt.day(instant.getTime())).toBe('30 июн.');
  });

  it('is empty for nullish or unparseable input', () => {
    expect(fmt.day(null)).toBe('');
    expect(fmt.day('')).toBe('');
    expect(fmt.day('not-a-date')).toBe('');
  });

  it('fmt.date renders a bare day key without inventing a time of day', () => {
    expect(fmt.date('2026-06-30')).toBe('30 июн.');
  });

  it('fmt.date keeps date+time for real timestamps', () => {
    const local = new Date(2026, 5, 30, 14, 30); // local-clock instant → stable expectation
    expect(fmt.date(local.toISOString())).toBe('30 июн., 14:30');
  });
});

describe('fmt', () => {
  it('formats grouped numbers and invalid values', () => {
    expect(fmt.num(1_234_567)).toBe(Math.round(1_234_567).toLocaleString('ru-RU').replace(/,/g, ' '));
    expect(fmt.num(12.6)).toBe('13');
    expect(fmt.num(null)).toBe('—');
    expect(fmt.num(Number.NaN)).toBe('—');
  });

  it('formats compact thousands and millions without trailing .0', () => {
    expect(fmt.short(1_000)).toBe('1k');
    expect(fmt.short(1_250)).toBe('1.3k');
    expect(fmt.short(2_000_000)).toBe('2M');
    expect(fmt.short(-3_400_000)).toBe('-3.4M');
    expect(fmt.short(null)).toBe('—');
  });

  it('formats headline KPIs: full under 10 000, compact from 10 000', () => {
    expect(fmt.kpi(4_749)).toBe(fmt.num(4_749));
    expect(fmt.kpi(9_999)).toBe(fmt.num(9_999));
    expect(fmt.kpi(10_000)).toBe('10k');
    expect(fmt.kpi(12_634)).toBe('12.6k');
    expect(fmt.kpi(-10_500)).toBe('-10.5k');
    expect(fmt.kpi(null)).toBe('—');
  });

  it('formats signed percentages with configurable precision', () => {
    expect(fmt.pct(12.345)).toBe('+12.35%');
    expect(fmt.pct(-2.5, 1)).toBe('-2.5%');
    expect(fmt.pct(0, 0)).toBe('+0%');
    expect(fmt.pct(Number.NaN)).toBe('—');
  });

  it('fmt.pctAbs: от 1% — один знак, ниже — два, ниже 0.1% — порог', () => {
    expect(fmt.pctAbs(0)).toBe('0%');
    expect(fmt.pctAbs(0.04)).toBe('<0.1%');
    expect(fmt.pctAbs(0.4)).toBe('0.40%');
    expect(fmt.pctAbs(4)).toBe('4.0%');
    expect(fmt.pctAbs(28.92)).toBe('28.9%');
    expect(fmt.pctAbs(100)).toBe('100.0%');
    // Границы правил: ровно 0.1% уже печатается, ровно 1% уходит на один знак.
    expect(fmt.pctAbs(0.1)).toBe('0.10%');
    expect(fmt.pctAbs(1)).toBe('1.0%');
    expect(fmt.pctAbs(null)).toBe('—');
    expect(fmt.pctAbs(Number.NaN)).toBe('—');
  });
});

// ЕДИНЫЙ ФОРМАТ ДАТ (U5): подпись любой даты в UI строит `fmt.day` («13 июл.»), а дневные
// разбивки сортируются по epoch-ms из `dayKeyToTs` ДО форматирования.
describe('fmt.day — канон подписи «13 июл.»', () => {
  it('держит канон на границах года и на «мая» без точки', () => {
    expect(fmt.day('2026-01-01')).toBe('1 янв.');
    expect(fmt.day('2026-05-18')).toBe('18 мая'); // ru-RU: май без сокращения → без точки
    expect(fmt.day('2026-07-13')).toBe('13 июл.');
    expect(fmt.day('2026-12-31')).toBe('31 дек.');
  });

  it('никогда не отдаёт dd.mm и англ. месяцы', () => {
    const labels = ['2026-01-01', '2026-06-05', '2026-12-31'].map((d) => fmt.day(d));
    labels.forEach((l) => {
      expect(l).not.toMatch(/^\d{2}\.\d{2}$/);
      expect(l).not.toMatch(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
    });
  });

  it('форматирует epoch-ms и Date тем же каноном', () => {
    const local = new Date(2026, 6, 13, 9, 0);
    expect(fmt.day(local.getTime())).toBe('13 июл.');
    expect(fmt.day(local)).toBe('13 июл.');
  });

  it('границы окон печатают год (fmt.dayYear) — окно сравнения пересекает Новый год', () => {
    expect(fmt.dayYear('2026-12-22')).toBe('22 дек. 2026 г.');
    expect(fmt.dayYear('2027-01-10')).toBe('10 янв. 2027 г.');
    expect(fmt.dayYear('')).toBe('');
    expect(fmt.dayYear(null)).toBe('');
  });
});

describe('dayKeyToTs — ключ сортировки дневных разбивок', () => {
  it('разбирает ISO-ключ как локальную полночь', () => {
    expect(dayKeyToTs('2026-07-13')).toBe(new Date(2026, 6, 13).getTime());
  });

  it('выводит год у «DD.MM» и держит порядок ЧЕРЕЗ НОВЫЙ ГОД', () => {
    const now = new Date(2027, 0, 5); // 5 января 2027
    expect(new Date(dayKeyToTs('28.12', now)!).getFullYear()).toBe(2026);
    expect(new Date(dayKeyToTs('03.01', now)!).getFullYear()).toBe(2027);
    const sorted = ['03.01', '28.12', '01.01', '31.12'].sort(
      (a, b) => (dayKeyToTs(a, now) ?? 0) - (dayKeyToTs(b, now) ?? 0),
    );
    expect(sorted).toEqual(['28.12', '31.12', '01.01', '03.01']);
  });

  it('порядок серии не зависит от формата подписи (сортируем по ts, форматируем после)', () => {
    const now = new Date(2027, 0, 5);
    const keys = ['03.01', '28.12', '01.01', '31.12'];
    const labels = [...keys]
      .sort((a, b) => (dayKeyToTs(a, now) ?? 0) - (dayKeyToTs(b, now) ?? 0))
      .map((k) => fmt.day(dayKeyToTs(k, now)));
    expect(labels).toEqual(['28 дек.', '31 дек.', '1 янв.', '3 янв.']);
  });

  it('внутри одного года месяцы не «уезжают» в прошлый год', () => {
    const now = new Date(2026, 11, 20); // 20 декабря 2026
    expect(new Date(dayKeyToTs('01.12', now)!).getFullYear()).toBe(2026);
    expect(new Date(dayKeyToTs('15.06', now)!).getFullYear()).toBe(2026);
  });

  it('возвращает null для нераспознанного ключа', () => {
    expect(dayKeyToTs('')).toBeNull();
    expect(dayKeyToTs('13 июл.')).toBeNull();
    expect(dayKeyToTs('13.99')).toBeNull();
  });
});

describe('ruSeriesName', () => {
  it('maps API-provided English series names to Russian', () => {
    expect(ruSeriesName('Views')).toBe('Просмотры');
    expect(ruSeriesName('Shares')).toBe('Репосты');
    expect(ruSeriesName('Followers')).toBe('Подписчики');
    expect(ruSeriesName('joined')).toBe('Подписались');
  });

  it('falls back to the original for unknown names and empty input', () => {
    expect(ruSeriesName('Story views')).toBe('Story views');
    expect(ruSeriesName('Просмотры')).toBe('Просмотры');
    expect(ruSeriesName(null)).toBe('');
    expect(ruSeriesName('  ')).toBe('');
  });
});

describe('spark paths', () => {
  it('draws a non-overshooting smooth cubic — one C segment per gap, exact endpoints', () => {
    // Horizontal control handles (midpoint x, endpoint y) keep every segment inside its pair's
    // value range: no Bezier control point ever sits above the higher point or below the lower.
    const path = sparkPath([0, 10, 5]);
    expect(path).toBe('M2.0,30.0 C51.0,30.0 51.0,2.0 100.0,2.0 C149.0,2.0 149.0,16.0 198.0,16.0');
    // One move + one cubic per adjacent pair (n − 1 cubics).
    expect(path.startsWith('M')).toBe(true);
    expect(path.match(/C/g)).toHaveLength(2);
    // Endpoints are exact: first/last drawn coordinate equals the point's own y (30.0 / 16.0).
    expect(path.startsWith('M2.0,30.0')).toBe(true);
    expect(path.endsWith('198.0,16.0')).toBe(true);
    // Every control-point y is one of the two adjacent point ys — never an overshoot value.
    const ys = [...path.matchAll(/,(-?\d+\.\d)/g)].map((m) => Number(m[1]));
    for (const y of ys) expect(y >= 2.0 && y <= 30.0).toBe(true);
    expect(sparkPath([])).toBe('');
  });

  it('closes the area path along the same smooth top, down to the baseline corners', () => {
    const area = sparkAreaPath([0, 10, 5]);
    // The fill top is the identical smooth stroke path; only the baseline close is appended.
    expect(area.startsWith(sparkPath([0, 10, 5]))).toBe(true);
    expect(area).toContain(' C');
    expect(area.endsWith('L200,32 L0,32 Z')).toBe(true);
    expect(sparkAreaPath([])).toBe('');
  });
});

describe('fmt.weekday + timeAxisLabels — буквенная ось короткого окна', () => {
  it('однобуквенные ЛАТИНСКИЕ дни недели: Mon=M … Sun=S (русская свёртка неоднозначна)', () => {
    // 2026-06-08 — понедельник.
    expect(['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14'].map((d) => fmt.weekday(d)))
      .toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(fmt.weekday(null)).toBe('');
    expect(fmt.weekday('не дата')).toBe('');
  });

  it('timeAxisLabels: буквы только для окна ≤ 8 дней и ряда 2–8 точек', () => {
    const week = ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14'];
    expect(timeAxisLabels(week, 7)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    // Разреженные дни ВНУТРИ короткого окна — буквы честны (день недели в окне уникален).
    expect(timeAxisLabels(['2026-06-09', '2026-06-11', '2026-06-13'], 7)).toEqual(['T', 'T', 'S']);
  });

  it('timeAxisLabels: длинное окно НЕ получает буквы — два понедельника с одной «M» лгут', () => {
    expect(timeAxisLabels(['2026-06-01', '2026-06-08', '2026-06-15'], 30)).toBeUndefined();
    // «Всё» (0) меряется размахом серии: двухдневный архив честно несёт буквы.
    expect(timeAxisLabels(['2026-06-08', '2026-06-09'], 0)).toEqual(['M', 'T']);
    expect(timeAxisLabels(['2026-06-08', '2026-06-09'], null)).toBeUndefined();
    // Одна точка — не ось; девять точек — окно уже не «короткое».
    expect(timeAxisLabels(['2026-06-08'], 7)).toBeUndefined();
    expect(timeAxisLabels(Array.from({ length: 9 }, (_, i) => `2026-06-${String(8 + i).padStart(2, '0')}`), 9)).toBeUndefined();
  });

  it('timeAxisLabels: непарсибельный ключ отменяет всю ось (никаких пустых тиков)', () => {
    expect(timeAxisLabels(['2026-06-08', 'total'], 7)).toBeUndefined();
  });
});

describe('timeAxis — EN-месяцы длинного окна (владелец, 2026-08-14)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** n дневных ключей, заканчивающихся endKey (UTC-арифметика, ключи календарные). */
  const dailyKeys = (endKey: string, n: number) => {
    const end = Date.parse(`${endKey}T00:00:00Z`);
    return Array.from({ length: n }, (_, i) =>
      new Date(end - (n - 1 - i) * DAY).toISOString().slice(0, 10),
    );
  };

  it('окно ≥ 90 дней: месяц у ПЕРВОЙ точки каждого месяца (включая частичный на кромке), между тиками пусто', () => {
    // 2026-05-17 … 2026-08-14, ровно 90 дней.
    const keys = dailyKeys('2026-08-14', 90);
    const axis = timeAxisFromDayKeys(keys)!;
    expect(axis).toHaveLength(90);
    expect(axis[0]).toBe('May'); // частичный май на кромке окна тоже подписан
    expect(axis[keys.indexOf('2026-06-01')]).toBe('Jun');
    expect(axis[keys.indexOf('2026-07-01')]).toBe('Jul');
    expect(axis[keys.indexOf('2026-08-01')]).toBe('Aug');
    expect(axis.filter((t) => t.length > 0)).toEqual(['May', 'Jun', 'Jul', 'Aug']);
  });

  it('между порогами (9–89 дней) ось остаётся датами', () => {
    expect(timeAxisFromDayKeys(dailyKeys('2026-08-14', 30))).toBeUndefined();
    expect(timeAxisFromDayKeys(dailyKeys('2026-08-14', 89))).toBeUndefined();
  });

  it('очень длинное окно: тиков ≤ 8, ТЕКУЩИЙ месяц всегда жив (шаг считается от него)', () => {
    const keys = dailyKeys('2026-08-14', 730);
    const axis = timeAxisFromDayKeys(keys)!;
    const ticks = axis.filter((t) => t.length > 0);
    expect(ticks.length).toBeLessThanOrEqual(8);
    // Последний непустой тик — месяц последнего ключа (на нём пилюля «сейчас»).
    const lastIdx = axis.reduce((acc, t, i) => (t.length > 0 ? i : acc), -1);
    expect(axis[lastIdx]).toBe('Aug');
    expect(lastIdx).toBe(keys.indexOf('2026-08-01'));
  });

  it('monthsOnly (недельные корзины): буквы дней выключены, месяцы работают', () => {
    // Короткая недельная серия — БЕЗ букв (буква дня у корзины-недели лгала бы).
    expect(timeAxisFromDayKeys(['2026-08-03', '2026-08-10'], { monthsOnly: true })).toBeUndefined();
    // Длинная недельная серия месяцы несёт: понедельники за ~5 месяцев.
    const mondays = Array.from({ length: 20 }, (_, i) =>
      new Date(Date.parse('2026-08-10T00:00:00Z') - (19 - i) * 7 * DAY).toISOString().slice(0, 10),
    );
    const axis = timeAxisFromDayKeys(mondays, { monthsOnly: true })!;
    expect(axis.filter((t) => t.length > 0).length).toBeGreaterThanOrEqual(4);
    expect(axis.some((t) => t === 'Aug')).toBe(true);
  });

  it('timeAxisLabels (окно известно строителю): ≥ 90 дней — месяцы, ≤ 8 — буквы', () => {
    const keys = dailyKeys('2026-08-14', 120);
    const axis = timeAxisLabels(keys, 120)!;
    expect(axis.filter((t) => t.length > 0).every((t) => /^[A-Z][a-z]{2}$/.test(t))).toBe(true);
    expect(timeAxisLabels(dailyKeys('2026-08-14', 30), 30)).toBeUndefined();
  });
});

// ── D5: одна система записи чисел на весь продукт ─────────────────────────────────────────────────
describe('десятичный разделитель — точка везде', () => {
  it('numFixed печатает точку, а не запятую', () => {
    // toLocaleString('ru-RU') давал «32,7», и на одном экране с «↑5.8%» это читалось как две
    // разные системы записи одной величины (аудит #554, D5).
    expect(fmt.numFixed(32.7, 1)).toBe('32.7');
    expect(fmt.numFixed(2.92, 2)).toBe('2.92');
    expect(fmt.numFixed(44.25, 1)).toBe('44.3');
    // Хвостовой ноль не печатается — семантика maximumFractionDigits, как у заменённого
    // toLocaleString: «R 2 дн.», а не «R 2.0 дн.».
    expect(fmt.numFixed(0, 1)).toBe('0');
    expect(fmt.numFixed(2, 1)).toBe('2');
    expect(fmt.numFixed(4.2, 1)).toBe('4.2');
  });

  it('разряды разделены неразрывным узким пробелом, а не запятой', () => {
    const out = fmt.numFixed(1234.5, 1);
    expect(out).toBe(`1${'\u202f'}234.5`);
    expect(out).not.toContain(',');
  });

  it('отрицательные несут типографский минус', () => {
    expect(fmt.numFixed(-2.5, 1)).toBe('−2.5');
  });

  it('pctFixed добавляет процент и сохраняет точность', () => {
    expect(fmt.pctFixed(24.6, 1)).toBe('24.6%');
    expect(fmt.pctFixed(2.345, 2)).toBe('2.35%');
    expect(fmt.pctFixed(null)).toBe('—');
  });

  it('ни один форматтер не отдаёт запятую как десятичный разделитель', () => {
    for (const v of [0.5, 12.34, 999.9, 1234.56, 1_000_000.5]) {
      expect(fmt.numFixed(v, 2)).not.toMatch(/\d,\d/);
      expect(fmt.pctFixed(v, 1)).not.toMatch(/\d,\d/);
      expect(fmt.num(v)).not.toMatch(/\d,\d/);
    }
  });
});
