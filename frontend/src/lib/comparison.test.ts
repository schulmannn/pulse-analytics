import { describe, expect, it } from 'vitest';
import { deltaLabel } from '@/components/DeltaPill';
import { compareWindows, deltaParts, formatDelta, NO_BASIS_TEXT } from '@/lib/comparison';
import { NO_BASIS_ALL_TIME, NO_BASIS_SHORT_ARCHIVE, pctDelta } from '@/lib/delta';
import { formatMetricNumber } from '@/lib/metricNumber';

const flow = (current: number | null | undefined, previous: number | null | undefined) =>
  compareWindows({ current, previous, kind: 'flow' });

describe('compareWindows — одно правило базы', () => {
  it('процент — от положительной базы, со знаком', () => {
    expect(flow(120, 100)).toMatchObject({ delta: 20, absolute: 20, unitMode: 'pct' });
    expect(flow(75, 100)).toMatchObject({ delta: -25, absolute: -25, unitMode: 'pct' });
    expect(flow(100, 100)).toMatchObject({ delta: 0, absolute: 0, unitMode: 'pct' });
  });

  it('база ≤ 0 — процента нет, абсолютный сдвиг (не переворот знака и не процент от минуса)', () => {
    expect(flow(15, 0)).toMatchObject({ delta: 15, absolute: 15, unitMode: 'abs' });
    // Чистый прирост −50 → +20: СДЭК делил бы на −50 и печатал −140%, TG — «+140%» от |−50|.
    expect(flow(20, -50)).toMatchObject({ delta: 70, absolute: 70, unitMode: 'abs' });
    expect(flow(-50, -20)).toMatchObject({ delta: -30, unitMode: 'abs' });
    expect(flow(0, 0)).toMatchObject({ delta: 0, unitMode: 'abs' });
  });

  it('отрицательное текущее при положительной базе — тоже абсолютный сдвиг (правило pctDelta)', () => {
    expect(flow(-50, 100)).toMatchObject({ delta: -150, absolute: -150, unitMode: 'abs' });
  });

  it('метрика-процент (ER) сравнивается в п.п., а не процентом от процента — и от нулевой базы тоже', () => {
    const er = compareWindows({ current: 3.3, previous: 2.1, kind: 'ratio', unit: 'percent' });
    expect(er.unitMode).toBe('pp');
    expect(er.delta).toBeCloseTo(1.2, 10);
    expect(compareWindows({ current: 1.5, previous: 0, kind: 'ratio', unit: 'percent' })).toMatchObject({
      delta: 1.5,
      unitMode: 'pp',
    });
  });

  it('нет базы — «нет базы» с причиной; причину знает считающий', () => {
    expect(flow(10, null)).toMatchObject({ delta: null, absolute: null, basis: null, noBasisReason: NO_BASIS_SHORT_ARCHIVE });
    expect(compareWindows({ current: 10, previous: null, kind: 'flow', noBasisReason: NO_BASIS_ALL_TIME }).noBasisReason).toBe(
      NO_BASIS_ALL_TIME,
    );
    expect(flow(10, Number.NaN).noBasisReason).toBe(NO_BASIS_SHORT_ARCHIVE);
    expect(flow(10, Number.POSITIVE_INFINITY).noBasisReason).toBe(NO_BASIS_SHORT_ARCHIVE);
  });

  it('прошлое окно агрегата без полного покрытия — «нет базы», даже если число есть', () => {
    for (const kind of ['flow', 'ratio'] as const) {
      const c = compareWindows({ current: 900, previous: 30, kind, coverage: { complete: false } });
      expect(c).toMatchObject({ delta: null, basis: null, noBasisReason: NO_BASIS_SHORT_ARCHIVE });
    }
    // Уровню достаточно самого замера базы: покрытие окна для него ничего не значит.
    expect(compareWindows({ current: 110, previous: 100, kind: 'stock', coverage: { complete: false } }).delta).toBe(10);
    expect(compareWindows({ current: 110, previous: 100, kind: 'flow', coverage: { complete: true } }).delta).toBe(10);
  });

  it('нет текущего значения — слоту сказать нечего (не «нет базы»)', () => {
    const c = flow(null, 100);
    expect(c).toMatchObject({ delta: null, absolute: null, basis: null, noBasisReason: null });
    expect(formatDelta(c)).toBeNull();
    // NaN — не число: ни дельты NaN в режиме 'abs', ни напечатанного «не числа».
    expect(flow(Number.NaN, 100)).toMatchObject({ delta: null, absolute: null, basis: null, noBasisReason: null });
    expect(formatDelta(flow(Number.NaN, 100))).toBeNull();
  });

  it('основание, окно и голос — рядом с числом', () => {
    const c = compareWindows({
      current: 120,
      previous: 100,
      kind: 'flow',
      currentWindow: { from: '2026-08-05', to: '2026-08-11' },
      previousWindow: { from: '2026-07-29', to: '2026-08-04' },
      evaluative: false,
    });
    expect(c.basis).toEqual({ dates: { from: '2026-07-29', to: '2026-08-04' }, value: 100 });
    expect(c.window).toEqual({ from: '2026-08-05', to: '2026-08-11' });
    expect(c.evaluative).toBe(false);
    expect(flow(1, 2)).toMatchObject({ evaluative: true, window: null, unit: 'number' });
    expect(flow(1, 2).basis).toEqual({ dates: null, value: 2 });
  });

  it('процент — ровно pctDelta на всей сетке: одна формула, а не копия', () => {
    const grid = [-100, -3, -0.5, 0, 0.004, 0.5, 1, 3, 99.96, 100, 250, 1e6];
    for (const current of grid) {
      for (const previous of grid) {
        const c = flow(current, previous);
        const canon = pctDelta(current, previous);
        if (canon) {
          expect(c.unitMode).toBe('pct');
          expect(Math.abs(c.delta ?? Number.NaN)).toBe(canon.pct);
          expect(Math.sign(c.delta ?? Number.NaN)).toBe(canon.dir === 'up' ? 1 : canon.dir === 'down' ? -1 : 0);
        } else {
          expect(c.unitMode).toBe('abs');
          expect(c.delta).toBe(current - previous);
        }
      }
    }
  });
});

describe('formatDelta — один формат, ноль — «±»', () => {
  it('процент: один знак, от 100% — целые; знак + / − (U+2212)', () => {
    expect(formatDelta(flow(112.34, 100))).toBe('+12.3%');
    expect(formatDelta(flow(95.5, 100))).toBe('−4.5%');
    expect(formatDelta(flow(223.4, 100))).toBe('+123%');
  });

  it('ноль и изменение ниже разрешения печати — нейтральный «±», направление flat', () => {
    expect(formatDelta(flow(100, 100))).toBe('±0%');
    expect(formatDelta(flow(100.04, 100))).toBe('±0%');
    expect(deltaParts(flow(100.04, 100))?.dir).toBe('flat');
    expect(formatDelta(flow(0, 0))).toBe('±0');
    // Абсолютный сдвиг, округлившийся до нуля, — тоже «±», а не «+0»; от половины — уже движение.
    expect(formatDelta(flow(0.4, 0))).toBe('±0');
    expect(deltaParts(flow(-0.3, 0))?.dir).toBe('flat');
    expect(formatDelta(flow(0.6, 0))).toBe('+1');
    expect(formatDelta(compareWindows({ current: 2.13, previous: 2.1, kind: 'ratio', unit: 'percent' }))).toBe('±0 п.п.');
  });

  it('п.п.: один знак', () => {
    expect(formatDelta(compareWindows({ current: 3.3, previous: 2.1, kind: 'ratio', unit: 'percent' }))).toBe('+1.2 п.п.');
    expect(formatDelta(compareWindows({ current: 1.6, previous: 2.1, kind: 'ratio', unit: 'percent' }))).toBe('−0.5 п.п.');
  });

  it('абсолютный сдвиг — по единице метрики (роль headline, рубли через formatMoney)', () => {
    expect(formatDelta(flow(531, 0))).toBe('+531');
    expect(formatDelta(flow(12_345, 0))).toBe('+12.3k');
    const rub = compareWindows({ current: 0, previous: -8200, kind: 'flow', unit: 'currency' });
    expect(formatDelta(rub)).toBe(`+${formatMetricNumber(8200, 'currency', 'headline')}`);
    expect(formatDelta(compareWindows({ current: 0, previous: 0, kind: 'flow', unit: 'currency' }))).toBe(
      `±${formatMetricNumber(0, 'currency', 'headline')}`,
    );
  });

  it('нет базы — одно слово', () => {
    expect(formatDelta(flow(10, null))).toBe(NO_BASIS_TEXT);
    expect(formatDelta(compareWindows({ current: 10, previous: 5, kind: 'flow', coverage: { complete: false } }))).toBe(
      NO_BASIS_TEXT,
    );
  });

  it('цифры процента те же, что у DeltaPill: переход карточек меняет только ноль', () => {
    const grid = [0.01, 0.04, 0.05, 1, 12.34, 99.94, 99.96, 100, 250.5, 1e4];
    for (const current of grid) {
      for (const previous of grid) {
        const pill = deltaLabel(pctDelta(current, previous));
        const text = formatDelta(flow(current, previous));
        if (pill == null) expect(text).toBe('±0%');
        else expect(text).toBe(pill.replace('↑', '+').replace('↓', '−'));
      }
    }
  });
});
