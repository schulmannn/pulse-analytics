import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BarChart } from '@/components/BarChart';
import { LineChart } from '@/components/LineChart';
import {
  activateChartControl,
  chartActivationIndex,
  chartControlAriaLabel,
  nextChartControlIndex,
} from './chartOverlayControl';

describe('chart overlay keyboard controller', () => {
  it('wires both drillable charts to one native named overlay button', () => {
    const common = {
      values: [10, 20, 30],
      labels: ['1 июл', '2 июл', '3 июл'],
      onPointClick: () => {},
    };
    const line = renderToStaticMarkup(<LineChart {...common} />);
    const bar = renderToStaticMarkup(<BarChart {...common} />);

    expect(line).toMatch(/<button type="button" aria-label="Открыть данные: 3 июл, 30\.[^"]+"/);
    expect(line).toContain('aria-keyshortcuts="ArrowLeft ArrowRight Home End"');
    expect(bar).toMatch(/<button type="button" aria-label="Открыть данные: 3 июл, 30\.[^"]+"/);
    expect(bar).toContain('aria-keyshortcuts="ArrowLeft ArrowRight Home End"');
  });

  it('moves the selected point with arrows/Home/End and changes its accessible name', () => {
    const labels = ['1 июл', '2 июл', '3 июл', '4 июл'];
    const values = ['10', '20', '30', '40'];
    let index = 1;
    const name = () => chartControlAriaLabel({
      index,
      label: labels[index],
      fallbackNoun: 'точка',
      value: values[index],
    });

    expect(name()).toContain('2 июл, 20');
    index = nextChartControlIndex('ArrowRight', index, labels.length) ?? index;
    expect(name()).toContain('3 июл, 30');
    index = nextChartControlIndex('Home', index, labels.length) ?? index;
    expect(name()).toContain('1 июл, 10');
    index = nextChartControlIndex('End', index, labels.length) ?? index;
    expect(name()).toContain('4 июл, 40');
    index = nextChartControlIndex('ArrowLeft', index, labels.length) ?? index;
    expect(name()).toContain('3 июл, 30');
  });

  it.each([
    ['LineChart', 'Enter'],
    ['LineChart', 'Space'],
    ['BarChart', 'Enter'],
    ['BarChart', 'Space'],
  ])(
    '%s %s activation calls onPointClick with the keyboard-selected index despite stale pointer data',
    (_chart, _key) => {
      const onPointClick = vi.fn();
      // Native button Enter/Space activation is a click with detail=0.
      activateChartControl(
        {
          detail: 0,
          controlIndex: 2,
          pointerIndex: 0,
          press: { x: 400, y: 300 },
          clientX: 0,
          clientY: 0,
        },
        onPointClick,
      );

      expect(onPointClick).toHaveBeenCalledOnce();
      expect(onPointClick).toHaveBeenCalledWith(2);
    },
  );

  it('keeps the pointer scrub guard while accepting a stationary pointer click', () => {
    expect(chartActivationIndex({
      detail: 1,
      controlIndex: 3,
      pointerIndex: 4,
      press: { x: 10, y: 10 },
      clientX: 30,
      clientY: 10,
    })).toBeNull();

    expect(chartActivationIndex({
      detail: 1,
      controlIndex: 3,
      pointerIndex: 4,
      press: { x: 10, y: 10 },
      clientX: 13,
      clientY: 12,
    })).toBe(4);
  });
});
