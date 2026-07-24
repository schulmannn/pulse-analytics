import { describe, expect, it } from 'vitest';
import { stepWidgetSize, widgetResizeTarget, widgetSizeWidths } from './widgetResize';

describe('widget resize grid snap', () => {
  it('maps S/M/L to the real six-column grid including gaps', () => {
    expect(widgetSizeWidths(1200, 24)).toEqual({
      third: 384,
      half: 588,
      full: 1200,
    });
  });

  it('snaps a horizontal corner drag to the nearest footprint', () => {
    const base = { startSize: 'third' as const, minSize: 'third' as const, containerWidth: 1200, columnGap: 24 };
    expect(widgetResizeTarget({ ...base, deltaX: 70 })).toBe('third');
    expect(widgetResizeTarget({ ...base, deltaX: 120 })).toBe('half');
    expect(widgetResizeTarget({ ...base, deltaX: 530 })).toBe('full');
  });

  it('never shrinks below the visualisation floor', () => {
    expect(
      widgetResizeTarget({
        startSize: 'full',
        minSize: 'half',
        deltaX: -1000,
        containerWidth: 1200,
        columnGap: 24,
      }),
    ).toBe('half');
    expect(stepWidgetSize('half', 'half', -1)).toBe('half');
  });

  it('steps through S/M/L for keyboard users', () => {
    expect(stepWidgetSize('third', 'third', 1)).toBe('half');
    expect(stepWidgetSize('half', 'third', 1)).toBe('full');
    expect(stepWidgetSize('full', 'third', 1)).toBe('full');
    expect(stepWidgetSize('full', 'third', -1)).toBe('half');
  });
});
