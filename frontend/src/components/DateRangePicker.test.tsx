import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateRangePicker, monthWeeks, shiftMonths, weekdayIndex } from './DateRangePicker';

const at = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

describe('DateRangePicker — calendar geometry', () => {
  it('indexes weekdays Monday-first', () => {
    // 1 июня 2026 — понедельник, 7 июня — воскресенье.
    expect(weekdayIndex(at(2026, 5, 1))).toBe(0);
    expect(weekdayIndex(at(2026, 5, 7))).toBe(6);
  });

  it('clamps a month step to the target month length instead of rolling over', () => {
    // 31 января + 1 месяц НЕ должно давать 3 марта (нативное поведение Date).
    const feb = new Date(shiftMonths(at(2026, 0, 31), 1));
    expect(feb.getMonth()).toBe(1);
    expect(feb.getDate()).toBe(28);

    // Високосный февраль сохраняет 29-е.
    const leapFeb = new Date(shiftMonths(at(2028, 0, 31), 1));
    expect(leapFeb.getMonth()).toBe(1);
    expect(leapFeb.getDate()).toBe(29);
  });

  it('steps a year with Shift+PageUp/PageDown semantics', () => {
    const back = new Date(shiftMonths(at(2026, 5, 15), -12));
    expect([back.getFullYear(), back.getMonth(), back.getDate()]).toEqual([2025, 5, 15]);
  });

  it('lays a month out in whole Monday-first weeks with padded blanks', () => {
    // Июль 2026 начинается в среду → две ведущие пустышки (Пн, Вт).
    const weeks = monthWeeks(new Date(2026, 6, 1));
    for (const week of weeks) expect(week).toHaveLength(7);

    expect(weeks[0][0]).toBeNull();
    expect(weeks[0][1]).toBeNull();
    expect(new Date(weeks[0][2] as number).getDate()).toBe(1);

    const days = weeks.flat().filter((ts): ts is number => ts != null);
    expect(days).toHaveLength(31);
    // Каждый непустой день лежит в столбце своего дня недели — иначе сетка «съезжает» на день.
    for (const week of weeks) {
      week.forEach((ts, column) => {
        if (ts != null) expect(weekdayIndex(ts)).toBe(column);
      });
    }
  });
});

describe('DateRangePicker — calendar a11y contract', () => {
  afterEach(() => vi.useRealTimers());

  const render = () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0)); // 15 июля 2026, середина месяца
    return renderToStaticMarkup(
      <DateRangePicker value={null} onApply={() => {}} onReset={() => {}} />,
    );
  };

  it('renders the month as a labelled native table, not a flat list of buttons', () => {
    const html = render();
    expect(html).toContain('<table aria-labelledby=');
    expect(html).toContain('<thead');
    expect(html).toContain('<tbody');
    expect(html).toContain('<tr');
    expect(html).toContain('<td');
    expect(html).toContain('<th scope="col"');
    expect(html).not.toContain('role="grid"');
    // Заголовки столбцов озвучиваются полным днём недели, а не «Пн».
    expect(html).toContain('aria-label="Понедельник"');
  });

  it('keeps exactly one day focusable (roving tabindex)', () => {
    const html = render();
    const focusable = html.match(/data-day="\d+"\s+tabindex="0"/g) ?? [];
    const unfocusable = html.match(/data-day="\d+"\s+tabindex="-1"/g) ?? [];
    expect(focusable).toHaveLength(1);
    // Остальные 30 дней июля вне tab-порядка — вход в сетку стоит одного Tab, а не тридцати одного.
    expect(unfocusable).toHaveLength(30);
  });

  it('marks today and leaves future days reachable but announced as unavailable', () => {
    const html = render();
    expect(html).toContain('aria-current="date"');
    // aria-disabled, а НЕ нативный disabled: иначе стрелка упирается в дыру в конце месяца.
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/data-day="\d+"[^>]*\sdisabled/);
    expect(html).toContain(', недоступно');
  });

  it('announces the pick state politely and hides the decorative read-out', () => {
    const html = render();
    expect(html).toContain('Период не выбран. Выберите начало периода.');
    expect(html).toContain('role="status"');
    // «→» и «…» читаются мусором — визуальная строка скрыта от скринридера.
    expect(html).toContain('aria-hidden="true"');
  });

  it('labels the preset row so it is not four loose buttons', () => {
    const html = render();
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend class="sr-only">Быстрый выбор периода</legend>');
  });
});
