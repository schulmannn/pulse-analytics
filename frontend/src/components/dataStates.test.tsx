import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
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
    expect(html).toContain('data-slot="empty"');
    expect(html).toContain('data-slot="empty-icon"');
    expect(html).toContain('border-0');
    expect(html).toContain('bg-transparent');
  });

  it('announces compact failures and preserves retry without nested page chrome', () => {
    const html = renderToStaticMarkup(
      <ErrorState compact size="table" title="Не удалось загрузить" onRetry={() => undefined} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Повторить');
    expect(html).toContain('min-h-32');
    expect(html).toContain('data-slot="empty"');
    expect(html).toContain('border-0');
    expect(html).toContain('bg-transparent');
  });

  it('uses the shared shadcn composition and a quiet solid surface for page-level states', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <EmptyState title="Отчётов пока нет" reason="Создайте первый отчёт." action={{ to: '/reports/new', label: 'Создать отчёт' }} />
      </MemoryRouter>,
    );

    expect(html).toContain('data-slot="empty-header"');
    expect(html).toContain('data-slot="empty-content"');
    expect(html).toContain('border-solid');
    expect(html).toContain('bg-muted/20');
    expect(html).toContain('Создать отчёт');
    expect(html).not.toContain('Создать отчёт →');
  });

  it('рисует призрак формы перед текстом и ничего не анимирует', () => {
    const html = renderToStaticMarkup(
      <EmptyState compact size="chart" ghost="bars" title="Нет данных за период" />,
    );

    // Порядок DOM: сначала силуэт, потом заголовок — иначе скринридер и порядок табов
    // расходятся с тем, что видит глаз, а текст уезжает под форму.
    expect(html.indexOf('data-slot="empty-ghost"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-slot="empty-ghost"')).toBeLessThan(html.indexOf('Нет данных за период'));
    // Скелетон загрузки мерцает, призрак пустоты — нет: одинаковая моторика склеила бы два разных
    // состояния в одно нечитаемое.
    expect(html).not.toMatch(/animate-/);
  });

  it('без пропа ghost карточка остаётся прежней — призрак не появляется сам собой', () => {
    // Проп необязательный: 150+ существующих вызовов не должны получить форму, которой у них
    // нет (у ErrorState её нет вовсе — ошибка не пустота).
    const empty = renderToStaticMarkup(<EmptyState compact size="chart" title="Нет данных" />);
    const failed = renderToStaticMarkup(<ErrorState compact size="chart" title="Не удалось загрузить" />);

    expect(empty).not.toContain('data-slot="empty-ghost"');
    expect(failed).not.toContain('data-slot="empty-ghost"');
  });

  it('силуэт ЗАМЕНЯЕТ значок Inbox, а не встаёт рядом с ним', () => {
    // Два «пустых» знака в одной карточке — шум: форма и есть значок.
    const html = renderToStaticMarkup(
      <EmptyState compact size="chart" ghost="line" title="Нет данных" />,
    );

    expect(html).toContain('data-slot="empty-ghost"');
    expect(html).not.toContain('data-slot="empty-icon"');
  });

  it('силуэт растёт только в свободное место и потому не может сделать карточку выше', () => {
    // ЗАМЕР: тело фикс-тайла 264px — это 181px, то есть контейнерный запрос tile-short (<15rem)
    // матчится в КАЖДОЙ карточке доски. Прятать призрак под ним значило бы не показать его нигде.
    // Вместо порога — арифметика флекса: `flex-grow` раздаёт только СВОБОДНОЕ место, и без
    // нижнего порога полоса схлопывается в ноль там, где текст занял слот целиком. Любой min-h
    // здесь вернул бы прод-класс багов «состояние не влезло в тайл».
    const html = renderToStaticMarkup(
      <EmptyState compact size="chart" ghost="bars" title="Нет данных" reason="Выберите другой период." />,
    );
    const ghostClass = /data-slot="empty-ghost"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';

    expect(ghostClass).toContain('flex-1');
    expect(ghostClass).not.toMatch(/(^|\s)min-h-(?!0)/);
    expect(ghostClass).not.toContain('tile-short:hidden');
  });

  it('в табличной полосе призрак всегда строки — линия обещала бы график, которого не будет', () => {
    const html = renderToStaticMarkup(
      <EmptyState compact size="table" ghost="line" title="Строк нет" />,
    );

    // Форма — обещание карточки. У таблицы это строки, чем бы ни попросил вызывающий.
    expect(html).toContain('data-ghost="rows"');
    expect(html).not.toContain('data-ghost="line"');
  });

  it('страничное состояние ставит призрак ВМЕСТО значка, а не рядом с ним', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <EmptyState
          ghost="bars"
          title="МойСклад не подключён"
          reason="Укажите токен API."
          action={{ to: '/connect', label: 'Подключить' }}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('data-slot="empty-ghost"');
    // Значка Inbox здесь нет: форма и есть значок (иначе две иконографии в одном столбце).
    expect(html).not.toContain('data-slot="empty-icon"');
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
