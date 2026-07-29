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
  it('delegates the pressed state and roving-focus structure to Radix', () => {
    const html = markup(
      <SegmentedControl ariaLabel="Период" value="30" onChange={() => {}} options={OPTIONS} />,
    );
    expect(html).toContain('data-slot="toggle-group"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-state="on"[^>]*data-slot="toggle-group-item"/);
    expect(html).toMatch(/data-segment-index="1"[^>]*>30д<\/button>/);
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

  it('keeps the Radix roving-focus container when the value matches no segment', () => {
    // Period tracks render with value='' once a custom range is picked. Radix keeps the group in
    // its roving-focus model while every option correctly reports an unpressed state.
    const html = markup(
      <SegmentedControl ariaLabel="Период" value="" onChange={() => {}} options={OPTIONS} />,
    );
    expect(html).toContain('data-slot="toggle-group"');
    expect(html.match(/aria-pressed="false"/g) ?? []).toHaveLength(OPTIONS.length);
    expect(html).not.toContain('aria-pressed="true"');
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
