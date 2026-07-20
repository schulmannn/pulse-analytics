import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton, TableSkeleton } from '@/components/ui/dataSkeleton';

describe('shared data states', () => {
  it('keeps compact empty-state context and reserves the requested footprint', () => {
    const html = renderToStaticMarkup(
      <EmptyState compact size="chart" title="Нет данных" reason="Выберите другой период." />,
    );

    expect(html).toContain('Нет данных');
    expect(html).toContain('Выберите другой период.');
    expect(html).toContain('min-h-40');
    expect(html).not.toContain('border-dashed');
  });

  it('announces compact failures and preserves retry without nested page chrome', () => {
    const html = renderToStaticMarkup(
      <ErrorState compact size="table" title="Не удалось загрузить" onRetry={() => undefined} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Повторить');
    expect(html).toContain('min-h-32');
    expect(html).not.toContain('border-dashed');
  });

  it('exposes readable loading status while hiding decorative skeleton geometry', () => {
    const chart = renderToStaticMarkup(<ChartSkeleton />);
    const table = renderToStaticMarkup(<TableSkeleton rows={2} columns={3} />);

    expect(chart).toContain('role="status"');
    expect(chart).toContain('aria-busy="true"');
    expect(chart).toContain('aria-label="Загрузка графика"');
    expect(table).toContain('aria-label="Загрузка таблицы"');
    expect(table).toContain('aria-hidden="true"');
  });
});
