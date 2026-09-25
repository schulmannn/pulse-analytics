import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, buttonVariants } from '@/components/ui/button';
import { SwatchButton } from '@/components/ui/swatch-button';

describe('mobile touch-target primitives', () => {
  it.each(['default', 'sm', 'xs', 'lg'] as const)('%s button keeps a 44px mobile height', (size) => {
    const classes = buttonVariants({ size });
    expect(classes).toContain('min-h-11');
    expect(classes).toContain('sm:min-h-0');
  });

  it.each(['icon', 'icon-sm', 'icon-xs'] as const)('%s button keeps a 44×44px mobile surface', (size) => {
    const classes = buttonVariants({ size });
    expect(classes).toContain('min-h-11');
    expect(classes).toContain('min-w-11');
    expect(classes).toContain('sm:min-h-0');
    expect(classes).toContain('sm:min-w-0');
  });

  it('keeps the colour sample compact inside the 44px swatch hit area', () => {
    const html = renderToStaticMarkup(
      <SwatchButton aria-label="Акцент" color="#533afd" selected />,
    );

    expect(html).toContain('data-mobile-touch-target=""');
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('sm:h-5 sm:w-5');
    expect(html).toContain('h-5 w-5');
  });

  it('adds the loader canon and disables a pending button without replacing its text', () => {
    const html = renderToStaticMarkup(<Button pending>Сохранение…</Button>);

    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-pending="true"');
    expect(html).toContain('loader-dots');
    expect(html).toContain('Сохранение…');
  });

  it('keeps pending content valid when Button delegates its element with asChild', () => {
    const html = renderToStaticMarkup(
      <Button asChild pending>
        <a href="/next">Переход…</a>
      </Button>,
    );

    expect(html).toContain('<a');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('loader-dots');
    expect(html).toContain('Переход…');
  });
});
