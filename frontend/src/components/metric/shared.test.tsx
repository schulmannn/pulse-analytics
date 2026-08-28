import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComparisonDelta, ComparisonDeltaRow, RailSection } from './shared';

// Эти элементы — общие для всех metric-страниц (7 вертикалей): тест пинит канон разметки,
// чтобы правка «для одной страницы» не разъехалась молча по остальным.

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

  // Канон дельт: ноль ничего не оценивает — ни verdant, ни ember.
  it('renders a flat delta as a neutral ± in muted ink', () => {
    const html = renderToStaticMarkup(<ComparisonDeltaRow delta={0} />);
    expect(html).toContain('±');
    expect(html).toContain('0.0%');
    expect(html).toContain('text-muted-foreground');
    expect(html).not.toContain('text-verdant');
    expect(html).not.toContain('text-ember');
  });
});

describe('ComparisonDelta', () => {
  // Направление НЕ смеет жить в одном цвете (WCAG 1.4.1): зрячему — глиф, скринридеру — слово.
  // Глиф скрыт от AT намеренно (озвучка «чёрный треугольник вверх» — шум), поэтому слово
  // обязано быть; тест пинит ровно это, чтобы «упрощение разметки» не съело озвучку направления.
  it('carries direction in the glyph AND in an sr-only word', () => {
    const up = renderToStaticMarkup(<ComparisonDelta delta={3} />);
    expect(up).toContain('<span aria-hidden="true">▲</span>');
    expect(up).toContain('<span class="sr-only">рост на </span>');

    const down = renderToStaticMarkup(<ComparisonDelta delta={-3} />);
    expect(down).toContain('<span aria-hidden="true">▼</span>');
    expect(down).toContain('<span class="sr-only">снижение на </span>');

    const flat = renderToStaticMarkup(<ComparisonDelta delta={0} />);
    expect(flat).toContain('<span aria-hidden="true">±</span>');
    expect(flat).toContain('без изменений');
  });

  // Единицы, отличные от процента (штуки подписчиков, п.п.), не плодят вторую разметку.
  it('accepts a unit formatter without changing glyph or ink', () => {
    const html = renderToStaticMarkup(<ComparisonDelta delta={-0.35} format={(abs) => `${abs.toFixed(2)} п.п.`} />);
    expect(html).toContain('▼');
    expect(html).toContain('0.35 п.п.');
    expect(html).toContain('text-ember');
  });

  it('never paints a filled chip', () => {
    const html = renderToStaticMarkup(<ComparisonDelta delta={9} />);
    expect(html).not.toContain('bg-verdant');
    expect(html).not.toContain('rounded-full');
  });

  // Метрика без сентимента (объём упоминаний) делит РАЗМЕТКУ рейла, но не вердикт: цвет снимается,
  // глиф и озвучка направления остаются. Тест пинит именно это — иначе унификация рейлов тихо
  // покрасит вертикаль, которая осознанно отказалась оценивать свои дельты.
  it('drops the verdict but keeps the glyph when the metric carries no sentiment', () => {
    const up = renderToStaticMarkup(<ComparisonDelta delta={12.3} evaluative={false} />);
    expect(up).toContain('▲');
    expect(up).toContain('рост на ');
    expect(up).toContain('text-muted-foreground');
    expect(up).not.toContain('text-verdant');

    const down = renderToStaticMarkup(<ComparisonDeltaRow delta={-12.3} evaluative={false} />);
    expect(down).toContain('▼');
    expect(down).not.toContain('text-ember');
  });
});
