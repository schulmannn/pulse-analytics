import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Snippet } from '@/components/ui/snippet';

describe('Snippet', () => {
  it('keeps a warning token and its 44px copy action in normal flow', () => {
    const html = renderToStaticMarkup(
      <Snippet value="pa_secret" label="Показывается один раз" tone="warn" />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('border-status-warn/40');
    expect(html).toContain('break-all');
    expect(html).toContain('data-mobile-touch-target=""');
    expect(html).toContain('min-h-11');
    expect(html).toContain('Копировать');
    expect(html).not.toContain('absolute');
    expect(html).not.toContain('pr-24');
  });

  it('renders multiline commands with their exact copy label', () => {
    const html = renderToStaticMarkup(
      <Snippet value={'one\ntwo'} multiline copyLabel="Скопировать команды" />,
    );

    expect(html).toContain('<pre');
    expect(html).toContain('one\ntwo');
    expect(html).toContain('Скопировать команды');
  });
});
