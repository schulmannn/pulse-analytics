import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Breakdown } from '@/components/Breakdown';

describe('Breakdown', () => {
  it('sanitizes non-finite item values before rendering row widths', () => {
    const html = renderToString(
      createElement(Breakdown, {
        items: [
          { label: 'bad-high', value: Number.POSITIVE_INFINITY },
          { label: 'bad-empty', value: Number.NaN },
          { label: 'good', value: 10 },
        ],
      }),
    );

    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
