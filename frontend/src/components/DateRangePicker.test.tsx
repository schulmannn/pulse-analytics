import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateRangePicker } from './DateRangePicker';

describe('DateRangePicker — shadcn calendar contract', () => {
  afterEach(() => vi.useRealTimers());

  const render = () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
    return renderToStaticMarkup(
      <DateRangePicker value={null} onApply={() => {}} onReset={() => {}} />,
    );
  };

  it('renders the React DayPicker grid with Russian Monday-first headings', () => {
    const html = render();
    expect(html).toContain('<table role="grid"');
    expect(html).toContain('aria-label="июль 2026"');
    expect(html).toContain('aria-label="понедельник"');
    expect(html).toContain('aria-label="воскресенье"');
    expect(html).toContain('>Пн</th>');
    expect(html).toContain('>Вс</th>');
  });

  it('keeps one calendar day in the tab order', () => {
    const html = render();
    const dayButtons = html.match(/<button[^>]+data-day="\d{2}\.\d{2}\.\d{4}"[^>]*>/g) ?? [];
    expect(dayButtons.length).toBeGreaterThanOrEqual(31);
    expect(dayButtons.filter((button) => button.includes('tabindex="0"'))).toHaveLength(1);
  });

  it('marks today and disables future dates', () => {
    const html = render();
    expect(html).toContain('data-today="true"');
    expect(html).toMatch(/data-day="16\.07\.2026"[^>]*disabled=""/);
    expect(html).not.toMatch(/data-day="15\.07\.2026"[^>]*disabled=""/);
  });

  it('announces the selection state and labels the preset group', () => {
    const html = render();
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend class="sr-only">Быстрый выбор периода</legend>');
    expect(html).toContain('role="status"');
    expect(html).toContain('Выберите начало и конец периода');
  });

  it('exposes standard month navigation labels', () => {
    const html = render();
    expect(html).toContain('aria-label="Предыдущий месяц"');
    expect(html).toContain('aria-label="Следующий месяц"');
  });
});
