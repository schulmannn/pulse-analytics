import { describe, expect, it } from 'vitest';
import { formatByRole, formatMetricNumber, formatMoney, formatMoneyDelta, moneyFormatterFor } from './metricNumber';

/**
 * Правило владельца: крупное число карточки сжимается ОТ 10 000. Ниже порога печатается полностью —
 * «6 124» человек читает как сумму, «6.1k» как оценку.
 *
 * До этого модуля одно и то же место жило по трём правилам: Telegram/Instagram сжимали от 10 000,
 * МойСклад от 1 000 («2k ₽» для двух тысяч), СДЭК не сжимал вовсе («1 000 000 ₽» съедало
 * полкарточки). Тесты фиксируют не форматы как таковые, а то, что правило ОДНО.
 */
describe('formatByRole — порог зависит от роли числа на экране', () => {
  it('headline: сжатие ровно от 10 000', () => {
    expect(formatByRole(9999, 'headline')).not.toMatch(/k/);
    expect(formatByRole(10_000, 'headline')).toBe('10k');
    expect(formatByRole(61_240, 'headline')).toBe('61.2k');
    expect(formatByRole(1_000_000, 'headline')).toBe('1M');
  });

  it('axis: сжатие от 1 000 — на оси решает ширина колонки, а не читаемость суммы', () => {
    expect(formatByRole(8_200, 'axis')).toBe('8.2k');
    expect(formatByRole(999, 'axis')).toBe('999');
  });

  it('exact: никогда не сжимается — сюда идут ЗА цифрой', () => {
    expect(formatByRole(1_000_000, 'exact')).not.toMatch(/[kMB]/);
    expect(formatByRole(61_240, 'exact')).not.toMatch(/[kMB]/);
  });

  it('пусто и NaN — прочерк, а не «0»', () => {
    for (const role of ['headline', 'axis', 'exact'] as const) {
      expect(formatByRole(null, role)).toBe('—');
      expect(formatByRole(undefined, role)).toBe('—');
      expect(formatByRole(Number.NaN, role)).toBe('—');
    }
  });
});

describe('formatMoney — рубль ставится ровно один раз', () => {
  it('умолчание — роль крупного числа карточки', () => {
    expect(formatMoney(1_000_000)).toBe('1M ₽');
    expect(formatMoney(2_000)).toMatch(/^2\s?000 ₽$/);
  });

  it('знак валюты не задваивается', () => {
    // Регресс: при переводе на общий модуль автозамена оставляла хвостовой ₽ и выходило «1M ₽₽».
    for (const n of [0, 999, 2_000, 61_240, 1_000_000]) {
      for (const role of ['headline', 'axis', 'exact'] as const) {
        expect(formatMoney(n, role).match(/₽/g)).toHaveLength(1);
      }
    }
  });

  it('пусто — прочерк без валюты', () => {
    expect(formatMoney(null)).toBe('—');
  });
});

describe('moneyFormatterFor — один регистр на весь набор', () => {
  it('крупный набор печатается компактно ЦЕЛИКОМ, включая мелкие числа', () => {
    // Иначе в одном кадре «−8 200» рядом с «+307.9k»: две записи одной величины читаются как две
    // разные величины (замечено на разборе «Что изменило выручку»).
    const f = moneyFormatterFor([307_900, -8_200, 45_000]);
    expect(f(307_900)).toBe('307.9k ₽');
    expect(f(8_200)).toBe('8.2k ₽');
  });

  it('мелкий набор целиком остаётся полным', () => {
    const f = moneyFormatterFor([1_200, -300, 900]);
    expect(f(1_200)).not.toMatch(/k/);
    expect(f(300)).not.toMatch(/k/);
  });

  it('пустой набор не падает', () => {
    expect(moneyFormatterFor([])(0)).toBe('0 ₽');
  });
});

describe('formatMetricNumber — единица решает правило', () => {
  it('проценты не сжимаются никогда: «12k%» — бессмыслица', () => {
    expect(formatMetricNumber(12.5, 'percent')).toMatch(/%$/);
    expect(formatMetricNumber(12.5, 'percent')).not.toMatch(/k/);
  });

  it('валюта несёт ₽, счётные единицы — нет', () => {
    expect(formatMetricNumber(50_000, 'currency')).toContain('₽');
    for (const unit of ['number', 'views', 'posts'] as const) {
      expect(formatMetricNumber(50_000, unit)).not.toContain('₽');
    }
  });

  it('порог у счётных единиц тот же, что у денег', () => {
    expect(formatMetricNumber(10_000, 'views', 'headline')).toBe(
      formatByRole(10_000, 'headline'),
    );
  });
});

// ── D4: знак валюты и знак дельты — по одному разу ────────────────────────────────────────────────
describe('деньги: один ₽ и один знак', () => {
  it('в строке денег ровно один знак рубля', () => {
    // На /sklad печаталось «61.9k ₽₽»: «₽» дописывали поверх строки, которая его уже несёт.
    for (const value of [0, 1, 6109, 61_900, 1_600_000, -2500]) {
      for (const role of ['headline', 'axis', 'exact'] as const) {
        expect(formatMoney(value, role).match(/₽/g)?.length).toBe(1);
      }
    }
  });

  it('число и ₽ разделены неразрывным узким пробелом — перенос между ними невозможен', () => {
    expect(formatMoney(6109, 'exact')).toContain('\u202f₽');
    expect(formatMoney(1_600_000, 'axis')).toContain('\u202f₽');
    // Обычного пробела перед знаком валюты быть не должно: из-за него «1.6M ₽» и «6 109₽»
    // соседствовали на одном экране.
    expect(formatMoney(6109, 'exact')).not.toContain(' ₽');
  });

  it('дельта печатает ЛИБО плюс, ЛИБО стрелку, но не оба', () => {
    expect(formatMoneyDelta(99_300)).toBe(`+${formatMoney(99_300, 'axis')}`);
    expect(formatMoneyDelta(-99_300)).toBe(`−${formatMoney(99_300, 'axis')}`);
    expect(formatMoneyDelta(99_300, { arrow: true })).toBe(`↑${formatMoney(99_300, 'axis')}`);
    expect(formatMoneyDelta(-99_300, { arrow: true })).toBe(`↓${formatMoney(99_300, 'axis')}`);
    for (const out of [formatMoneyDelta(99_300), formatMoneyDelta(99_300, { arrow: true })]) {
      expect(out.match(/₽/g)?.length).toBe(1);
      expect(/[↑↓].*[+−]/.test(out)).toBe(false);
    }
  });

  it('ноль и пустое значение не выдумывают направление', () => {
    expect(formatMoneyDelta(0)).toBe(formatMoney(0, 'axis'));
    expect(formatMoneyDelta(null)).toBe('—');
    expect(formatMoneyDelta(undefined)).toBe('—');
  });
});
