import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RadialShare } from './RadialShare';
import { ShareRows, ShareTrack } from './ShareRows';

const markup = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const text = (html: string) => html.replace(/<[^>]*>/g, '');

describe('ShareTrack — honest part-to-whole scale', () => {
  it('renders zero and sub-1.5% shares at their real width', () => {
    const zero = markup(<ShareTrack pct={0} />);
    const small = markup(<ShareTrack pct={0.5} />);

    expect(zero).toContain('width:0%');
    expect(zero).toContain('aria-label="Доля 0.0%"');
    expect(small).toContain('width:0.5%');
    expect(small).toContain('aria-label="Доля 0.5%"');
  });

  it('bounds malformed CSS widths without hiding a finite over-100 input', () => {
    const over = markup(<ShareTrack pct={150} />);
    const notFinite = markup(<ShareTrack pct={Number.POSITIVE_INFINITY} />);
    const negative = markup(<ShareTrack pct={-12} />);

    expect(over).toContain('width:100%');
    expect(over).toContain('aria-label="Доля 150.0%, визуальная шкала ограничена 100%"');
    expect(over).toContain('data-share-percent="150"');
    expect(notFinite).toContain('width:0%');
    expect(notFinite).not.toContain('Infinity');
    expect(negative).toContain('width:0%');
    expect(negative).toContain('data-share-percent="0"');
  });

  it('can be hidden when adjacent text already carries the percentage', () => {
    const html = markup(<ShareTrack pct={25} ariaLabel={null} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain('aria-label=');
  });
});

describe('ShareRows — persistent value and percentage', () => {
  it('keeps exact values and shares in visible/list semantics, without a hover-only tooltip', () => {
    const html = markup(
      <ShareRows
        rows={[
          { key: 'small', label: 'Малая доля', value: 1 },
          { key: 'zero', label: 'Нулевая доля', value: 0 },
          { key: 'over', label: 'Ошибка знаменателя', value: 300 },
        ]}
        total={200}
        tailWord="визитов"
        expanded
        format={(value) => String(value)}
      />,
    );

    expect(html).toContain('<ul aria-label="Распределение, всего 200 визитов"');
    expect(html).toContain('Малая доля');
    expect(html).toContain('aria-label="Доля 0.5%"');
    expect(html).toContain('aria-label="Доля 0.0%"');
    expect(html).toContain('aria-label="Доля 150.0%"');
    expect(html).toContain('width:0.5%');
    expect(html).toContain('width:0%');
    expect(html).toContain('width:100%');
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain('tabindex=');
  });

  it('uses a two-line narrow layout before the desktop three-column row', () => {
    const html = markup(
      <ShareRows
        rows={[{ key: 'row', label: 'Очень длинная подпись источника', value: 40 }]}
        total={100}
        tailWord="визитов"
      />,
    );

    // At 320/390px label and number share row 1; the min-w-0 track owns row 2. At sm it returns
    // to the compact label / track / number columns.
    expect(html).toContain('grid-cols-[minmax(0,1fr)_minmax(0,1fr)]');
    expect(html).toContain('sm:grid-cols-[minmax(7rem,42%)_minmax(3rem,1fr)_auto]');
    expect(html).toContain('col-span-2 row-start-2 flex min-w-0');
    expect(html).toContain('sm:col-span-1 sm:col-start-2 sm:row-start-1');
  });

  it('does not invent a percentage when the supplied total is invalid', () => {
    const html = markup(
      <ShareRows
        rows={[{ key: 'row', label: 'Источник', value: Number.NaN }]}
        total={Number.NaN}
        tailWord="визитов"
        format={(value) => String(value)}
      />,
    );

    expect(html).toContain('Распределение: визитов');
    expect(html).toContain('aria-label="Доля —"');
    expect(text(html)).not.toContain('NaN');
    expect(html).toContain('width:0%');
  });
});

describe('RadialShare — accessible composition', () => {
  it('names the total and exposes raw segment/rest values in its persistent legend', () => {
    const html = markup(
      <RadialShare
        segments={[
          { key: 'mobile', label: 'Мобильные', value: 60 },
          { key: 'desktop', label: 'Компьютеры', value: 20 },
        ]}
        total={100}
        unitWord="визитов"
        format={(value) => String(value)}
      />,
    );
    const plain = text(html);

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-labelledby=');
    expect(plain).toContain('Всего 100 визитов.');
    expect(plain).toContain('Мобильные — 60 визитов, 60.0%');
    expect(plain).toContain('Компьютеры — 20 визитов, 20.0%');
    expect(plain).toContain('Не определено — 20 визитов, 20.0%');
    expect(html).toContain('aria-label="Легенда состава"');
    expect(plain).toContain('60 визитов · 60.0%');
    expect(plain).toContain('20 визитов · 20.0%');
  });

  it('keeps the passive visualization out of keyboard order while leaving all data as text', () => {
    const html = markup(
      <RadialShare
        segments={[
          { key: 'tiny', label: 'Малая группа', value: 1 },
          { key: 'main', label: 'Основная группа', value: 199 },
        ]}
        total={200}
        unitWord="визитов"
        format={(value) => String(value)}
      />,
    );

    expect(html).toContain('Малая группа');
    expect(text(html)).toContain('1 визитов · 0.5%');
    expect(html).toContain('focusable="false"');
    expect(html).not.toContain('tabindex=');
    expect(html).not.toContain('role="tooltip"');
  });

  it('drops invalid segments and falls back from an invalid total without malformed SVG', () => {
    const html = markup(
      <RadialShare
        segments={[
          { key: 'ok', label: 'Валидно', value: 5 },
          { key: 'negative', label: 'Отрицательно', value: -2 },
          { key: 'nan', label: 'Не число', value: Number.NaN },
          { key: 'infinity', label: 'Бесконечность', value: Number.POSITIVE_INFINITY },
        ]}
        total={Number.POSITIVE_INFINITY}
        unitWord="визитов"
        format={(value) => String(value)}
      />,
    );

    expect(text(html)).toContain('Всего 5 визитов.');
    expect(text(html)).toContain('Валидно — 5 визитов, 100.0%');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
    expect(text(html)).not.toContain('Отрицательно');
    expect(text(html)).not.toContain('Бесконечность');
  });

  it('renders nothing when every segment is zero or invalid', () => {
    expect(
      markup(
        <RadialShare
          segments={[
            { key: 'zero', label: 'Ноль', value: 0 },
            { key: 'nan', label: 'Не число', value: Number.NaN },
          ]}
          total={100}
          unitWord="визитов"
        />,
      ),
    ).toBe('');
  });
});
