import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SearchField } from './SearchField';

const markup = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe('SearchField', () => {
  it('renders an accessible search input with placeholder and test id, no clear button when empty', () => {
    const html = markup(
      <SearchField
        value=""
        onChange={() => {}}
        ariaLabel="Поиск по публикациям"
        placeholder="Поиск по тексту"
        testId="content-search"
      />,
    );
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Поиск по публикациям"');
    expect(html).toContain('placeholder="Поиск по тексту"');
    expect(html).toContain('data-testid="content-search"');
    // The leading search glyph is always present…
    expect(html).toContain('<svg');
    // …but the clear affordance only appears once there is a query to clear.
    expect(html).not.toContain('Очистить поиск');
  });

  it('shows a clear button with an explicit Russian accessible name once non-empty', () => {
    const html = markup(
      <SearchField value="куртка" onChange={() => {}} ariaLabel="Поиск" />,
    );
    expect(html).toContain('aria-label="Очистить поиск"');
    expect(html).toContain('value="куртка"');
  });

  it('honours a custom clear label', () => {
    const html = markup(
      <SearchField value="x" onChange={() => {}} ariaLabel="Поиск" clearLabel="Сбросить" />,
    );
    expect(html).toContain('aria-label="Сбросить"');
  });

  it('announces the result count in a polite live region only when the caller supplies one', () => {
    const withCount = markup(
      <SearchField value="куртка" onChange={() => {}} ariaLabel="Поиск" resultsLabel="3 отчёта" />,
    );
    expect(withCount).toContain('aria-live="polite"');
    expect(withCount).toContain('role="status"');
    expect(withCount).toContain('3 отчёта');
    // Visually hidden: the count is an announcement, not a second on-screen counter.
    expect(withCount).toContain('sr-only');

    // A surface with no count renders no empty live region (an empty one still gets polled).
    const withoutCount = markup(<SearchField value="куртка" onChange={() => {}} ariaLabel="Поиск" />);
    expect(withoutCount).not.toContain('aria-live');
  });

  it('renders a zero-result announcement rather than falling back to silence', () => {
    const html = markup(
      <SearchField value="zzz" onChange={() => {}} ariaLabel="Поиск" resultsLabel="0 отчётов" />,
    );
    expect(html).toContain('0 отчётов');
  });
});
