import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

const markup = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

const OPTIONS = [
  { value: '7', content: '7д' },
  { value: '30', content: '30д' },
  { value: '90', content: '90д' },
];

describe('SegmentedControl — keyboard contract', () => {
  it('is one tab stop: only the selected segment is focusable', () => {
    const html = markup(
      <SegmentedControl ariaLabel="Период" value="30" onChange={() => {}} options={OPTIONS} />,
    );
    expect(html.match(/tabindex="0"/g) ?? []).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g) ?? []).toHaveLength(2);
    // The focusable one is the selected one, so Tab lands on the current answer.
    expect(html).toMatch(/data-segment-index="1"[^>]*aria-pressed="true"[^>]*tabindex="0"/);
  });

  it('announces a pattern where arrows are expected', () => {
    const html = markup(
      <SegmentedControl ariaLabel="Тип графика" value="7" onChange={() => {}} options={OPTIONS} />,
    );
    // A roving tabindex is only discoverable if the container says arrows work here — a plain
    // group would leave a keyboard user unable to reach the other segments at all.
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-orientation="horizontal"');
    expect(html).toContain('aria-label="Тип графика"');
  });

  it('keeps a track focusable when the value matches no segment', () => {
    // Period tracks render with value='' once a custom range is picked (the glider hides). If the
    // roving caret keyed off the selected value alone, nothing would be focusable and the control
    // would drop out of the tab order entirely.
    const html = markup(
      <SegmentedControl ariaLabel="Период" value="" onChange={() => {}} options={OPTIONS} />,
    );
    expect(html.match(/tabindex="0"/g) ?? []).toHaveLength(1);
  });

  it('leaves a disabled segment reachable and self-explaining', () => {
    const html = markup(
      <SegmentedControl
        ariaLabel="Грануляция"
        value="7"
        onChange={() => {}}
        options={[
          { value: '7', content: 'День' },
          { value: '30', content: 'Неделя', disabled: true, title: 'Нужно ≥14 дней данных' },
        ]}
      />,
    );
    expect(html).toContain('aria-disabled="true"');
    // NOT the native attribute: it would drop the segment out of arrow navigation and swallow the
    // title, since disabled elements fire no mouse events.
    expect(html).not.toMatch(/data-segment-index="1"[^>]*\sdisabled/);
    expect(html).toContain('title="Нужно ≥14 дней данных"');
  });

  it('renders nothing rather than a malformed track when there are no options', () => {
    expect(markup(<SegmentedControl ariaLabel="Пусто" value="" onChange={() => {}} options={[]} />)).toBe('');
  });
});
