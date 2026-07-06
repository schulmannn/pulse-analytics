import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BarChart } from '@/components/BarChart';

describe('BarChart', () => {
  it('sanitizes non-finite current and ghost values before rendering SVG', () => {
    const originalError = console.error;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
      if (String(message).includes('useLayoutEffect does nothing on the server')) return;
      originalError(message, ...args);
    });

    try {
      const html = renderToString(
        createElement(BarChart, {
          values: [Number.POSITIVE_INFINITY, Number.NaN, 12],
          labels: ['bad-high', 'bad-empty', 'good'],
          ghost: [5, Number.NEGATIVE_INFINITY, Number.NaN],
        }),
      );

      expect(html).not.toMatch(/NaN|Infinity/);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
