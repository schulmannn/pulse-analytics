import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KpiNumber, parseKpiText } from '@/components/KpiNumber';
import { fmt } from '@/lib/format';

const NBSP = '\u00A0';

describe('parseKpiText', () => {
  it('разбирает полные числа с ru-группировкой', () => {
    expect(parseKpiText(`4${NBSP}749`)).toEqual({
      value: 4749,
      plus: false,
      fractionDigits: 0,
      grouped: true,
      suffix: '',
    });
    expect(parseKpiText(`1${NBSP}234${NBSP}567`)?.value).toBe(1234567);
  });

  it('разбирает компакт fmt.short и проценты с суффиксом', () => {
    expect(parseKpiText('12.6k')).toEqual({
      value: 12.6,
      plus: false,
      fractionDigits: 1,
      grouped: false,
      suffix: 'k',
    });
    expect(parseKpiText('28.9%')).toMatchObject({ value: 28.9, suffix: '%' });
    expect(parseKpiText('8.20%')).toMatchObject({ fractionDigits: 2 });
    expect(parseKpiText('0%')).toMatchObject({ value: 0, suffix: '%' });
    expect(parseKpiText('13')).toMatchObject({ value: 13, fractionDigits: 0, suffix: '' });
  });

  it('понимает явные знаки: «+» — да, минус U+2212 — фолбэк', () => {
    expect(parseKpiText(`+3${NBSP}210`)).toMatchObject({ value: 3210, plus: true });
    expect(parseKpiText('-1234')).toMatchObject({ value: -1234, plus: false });
    expect(parseKpiText(`−1${NBSP}234`)).toBeNull();
  });

  it('отклоняет нечисловые строки (остаются на снапе ValueSwap)', () => {
    expect(parseKpiText('—')).toBeNull();
    expect(parseKpiText('<0.1%')).toBeNull();
    expect(parseKpiText('')).toBeNull();
    // Группировка + дробь одновременно: домашние форматтеры такого не производят, Intl отдал бы
    // запятую вместо точки — честный отказ.
    expect(parseKpiText(`1${NBSP}234.5`)).toBeNull();
  });

  it('ИНВАРИАНТ: Intl с разобранными параметрами воспроизводит строку посимвольно', () => {
    const corpus = [
      ...[0, 5, 999, 4749, 9999, -1234].map((n) => fmt.num(n)),
      ...[10_000, 12_600, 934_100, 1_234_567, 2.4e9].map((n) => fmt.kpi(n)),
      ...[28.94, 5.0, 0.42].map((p) => fmt.pctAbs(p)),
    ];
    for (const text of corpus) {
      const parsed = parseKpiText(text);
      expect(parsed, text).not.toBeNull();
      if (!parsed) continue;
      const rebuilt =
        new Intl.NumberFormat(parsed.grouped ? 'ru-RU' : 'en-US', {
          useGrouping: parsed.grouped,
          minimumFractionDigits: parsed.fractionDigits,
          maximumFractionDigits: parsed.fractionDigits,
          ...(parsed.plus ? { signDisplay: 'always' as const } : null),
        }).format(parsed.value) + parsed.suffix;
      expect(rebuilt, text).toBe(text);
    }
  });
});

describe('KpiNumber', () => {
  it('нечисловая строка рендерится прежним ValueSwap-снапом', () => {
    const html = renderToStaticMarkup(<KpiNumber text="—" />);
    expect(html).toContain('value-swap');
    expect(html).toContain('—');
    expect(html).not.toContain('number-flow');
  });

  it('числовая строка делится на ядро и тихий суффикс (SSR отдаёт Suspense-фолбэк)', () => {
    const html = renderToStaticMarkup(
      <KpiNumber text="12.6k" unitClassName="text-base text-muted-foreground" />,
    );
    expect(html).toContain('12.6');
    expect(html).toContain('>k</span>');
    expect(html).toContain('text-muted-foreground');
    expect(html).not.toContain('value-swap');
  });

  it('держит контракт плоского текста: РОВНО одна light-копия ядра (SSR = фолбэк до чанка)', () => {
    const html = renderToStaticMarkup(<KpiNumber text="12.6k" />);
    const flat = html.replace(/<[^>]+>/g, '');
    // Suspense-фолбэк: видимое ядро + видимый суффикс, БЕЗ sr-only дубля — иначе strict-mode
    // getByText ловит два элемента «145» (ym-overview:377). sr-only появляется только вместе
    // с загруженным NumberFlow, когда визуальный слой уходит под aria-hidden.
    expect(flat).toBe('12.6k');
    expect(html).not.toContain('sr-only');
    expect(html).not.toContain('value-swap');
  });
});
