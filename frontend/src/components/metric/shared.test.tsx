import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AboutRow, ComparisonDeltaRow } from './shared';

// Эти элементы — общие для всех metric-страниц (7 вертикалей): тест пинит канон разметки,
// чтобы правка «для одной страницы» не разъехалась молча по остальным.

describe('AboutRow', () => {
  it('renders the term/description pair with the canonical classes', () => {
    const html = renderToStaticMarkup(<AboutRow label="Как считается" text="Сумма за окно." />);
    expect(html).toContain('<dt class="text-2xs tracking-wide text-muted-foreground">Как считается</dt>');
    expect(html).toContain('Сумма за окно.');
  });
});

describe('ComparisonDeltaRow', () => {
  it('renders growth as ▲ in verdant with one decimal', () => {
    const html = renderToStaticMarkup(<ComparisonDeltaRow delta={12.345} />);
    expect(html).toContain('Изменение');
    expect(html).toContain('▲');
    expect(html).toContain('12.3%');
    expect(html).toContain('text-verdant');
  });

  it('renders decline as ▼ in ember with the absolute value', () => {
    const html = renderToStaticMarkup(<ComparisonDeltaRow delta={-7.44} />);
    expect(html).toContain('▼');
    expect(html).toContain('7.4%');
    expect(html).toContain('text-ember');
    expect(html).not.toContain('-7');
  });
});
