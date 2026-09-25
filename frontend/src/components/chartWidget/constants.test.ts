import { describe, expect, it } from 'vitest';
import { SIZE_COL_SPAN } from '@/components/chartWidget/constants';
import { CARD_SPAN } from '@/components/WidgetErrorBoundary';

describe('widget desktop footprints', () => {
  it('maps the internal S/M/L footprints to a six-column grid literally', () => {
    expect(SIZE_COL_SPAN).toEqual({
      third: 'lg:col-span-2',
      half: 'lg:col-span-3',
      full: 'lg:col-span-6',
    });
  });

  // Аварийная карточка обязана занимать РОВНО тот же footprint, что здоровая: её локальная копия
  // карты (WidgetErrorBoundary держит её, чтобы leaf-boundary не тянул тяжёлый ChartWidget) уже
  // разъезжалась — `half` был `lg:col-span-4`, и ряд «3+3» превращался в «4+3» > 6 колонок.
  it('keeps the error-boundary fallback footprint identical to the healthy widget', () => {
    expect(CARD_SPAN).toEqual(SIZE_COL_SPAN);
  });
});
