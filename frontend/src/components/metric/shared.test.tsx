import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AboutRow, ComparisonDeltaRow, RailSection } from './shared';

// Эти элементы — общие для всех metric-страниц (7 вертикалей): тест пинит канон разметки,
// чтобы правка «для одной страницы» не разъехалась молча по остальным.

describe('AboutRow', () => {
  it('renders the term/description pair with the canonical classes', () => {
    const html = renderToStaticMarkup(<AboutRow label="Как считается" text="Сумма за окно." />);
    expect(html).toContain('<dt class="text-2xs tracking-wide text-muted-foreground">Как считается</dt>');
    expect(html).toContain('Сумма за окно.');
  });
});

describe('RailSection', () => {
  it('renders the flat variant: hairline heading, no card frame', () => {
    const html = renderToStaticMarkup(
      <RailSection title="О метрике">
        <p>тело</p>
      </RailSection>,
    );
    expect(html).toContain('class="space-y-3"');
    expect(html).toContain('h-px flex-1 bg-border');
    expect(html).not.toContain('rounded-2xl');
    expect(html).not.toContain('bg-card');
  });

  it('renders the card variant with the composer-rail frame and no hairline', () => {
    const html = renderToStaticMarkup(
      <RailSection title="Сравнение" variant="card">
        <p>тело</p>
      </RailSection>,
    );
    expect(html).toContain('rounded-2xl border border-border bg-card p-4 shadow-xs dark:border-white/6 sm:p-5');
    expect(html).toContain('<h3 class="text-xs font-medium tracking-wider text-muted-foreground">Сравнение</h3>');
    expect(html).toContain('<div class="mt-3">');
    expect(html).not.toContain('h-px flex-1 bg-border');
  });

  // Регрессия #367: card-ветка НЕ должна нести space-y-* — дети MetricPage расставляют
  // собственные mt-1/mt-3/mt-4, и ритм от контейнера сдвинул бы геометрию карточки.
  it('never puts vertical rhythm on the card container', () => {
    const html = renderToStaticMarkup(
      <RailSection title="Разбивка" variant="card">
        <p>тело</p>
      </RailSection>,
    );
    expect(html).not.toContain('space-y-');
  });

  it('keeps data-rail-card in both variants — e2e locates the rail by it', () => {
    for (const variant of ['flat', 'card'] as const) {
      const html = renderToStaticMarkup(
        <RailSection title="Сравнение" mark="comparison" variant={variant}>
          <p>тело</p>
        </RailSection>,
      );
      expect(html).toContain('data-rail-card="comparison"');
    }
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
