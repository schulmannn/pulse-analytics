import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LineChart } from './LineChart';
import { BarChart } from './BarChart';

/**
 * ЗАМОК НА РАЗМЕТКУ ЛЕГЕНДЫ ПОЛОТНА (R3).
 *
 * Легенда переехала из LineChart/BarChart в общий `metric/seriesLegend`, чтобы рейл «Сравнение»
 * рисовал ТЕ ЖЕ маркеры, что и график. Перенос обязан быть чистым: у этой строки выверены отступ
 * до полотна (`mb-1.5`) и поведение при выключенном сравнении (чип становится невидимым, но
 * остаётся в потоке — иначе таймбар под графиком прыгает на 21px), и «заодно причесать» её нельзя.
 *
 * Эталоны ниже сняты с origin/main ДО переноса — дословно, вместе с висячим пробелом в классе
 * кнопки. Тест сравнивает байты, а не смысл: любая правка `seriesLegend` в chart-layout обязана
 * сначала объяснить себя здесь.
 */
const legendOf = (html: string) => html.slice(0, html.indexOf('<svg'));

const LINE_PRIMARY =
  '<span class="flex select-none items-center gap-1.5">' +
  '<span aria-hidden="true" class="h-0.5 w-4 rounded-full" style="background-color:hsl(var(--chart-role-primary))"></span>' +
  'Текущий период</span>';
const LINE_GHOST_MARK =
  '<span aria-hidden="true" class="w-4 border-t-2 border-dashed" style="border-color:hsl(var(--chart-role-comparison))"></span>';
const BAR_PRIMARY =
  '<span class="flex select-none items-center gap-1.5">' +
  '<span aria-hidden="true" class="h-2 w-3 rounded-sm" style="background-color:hsl(var(--chart-role-primary))"></span>' +
  'Текущий период</span>';
const BAR_GHOST_MARK =
  '<span aria-hidden="true" class="h-2 w-3 rounded-sm" style="background-color:hsl(var(--chart-role-comparison) / 0.8)"></span>';

const row = (chips: string) =>
  '<div class="w-full"><div class="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-2xs font-medium text-muted-foreground">' +
  chips +
  '</div><div class="relative w-full">';

const toggleChip = (mark: string) =>
  '<button type="button" aria-pressed="true" title="Скрыть сравнение" class="flex select-none items-center gap-1.5 rounded ' +
  'transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 ">' +
  mark +
  'Прошлый период</button>';

const staticChip = (mark: string, hidden: boolean) =>
  `<span class="flex select-none items-center gap-1.5${hidden ? ' invisible' : ''}" aria-hidden="${hidden}">` +
  mark +
  'Прошлый период</span>';

describe('легенда полотна: разметка не изменилась после переноса в seriesLegend', () => {
  it('линия — чип-переключатель, статичный чип и его невидимое состояние', () => {
    expect(legendOf(renderToStaticMarkup(<LineChart values={[1, 2, 3, 4]} ghost={[2, 3, 4, 5]} />))).toBe(
      row(LINE_PRIMARY + toggleChip(LINE_GHOST_MARK)),
    );
    expect(
      legendOf(renderToStaticMarkup(<LineChart values={[1, 2, 3, 4]} ghost={[2, 3, 4, 5]} legendToggle={false} />)),
    ).toBe(row(LINE_PRIMARY + staticChip(LINE_GHOST_MARK, false)));
    expect(
      legendOf(
        renderToStaticMarkup(
          <LineChart values={[1, 2, 3, 4]} ghost={[2, 3, 4, 5]} legendToggle={false} ghostVisible={false} />,
        ),
      ),
    ).toBe(row(LINE_PRIMARY + staticChip(LINE_GHOST_MARK, true)));
  });

  it('столбцы — свотчи вместо штрихов, альфа призрака та же, что у самих столбцов', () => {
    expect(legendOf(renderToStaticMarkup(<BarChart values={[1, 2, 3, 4]} ghost={[2, 3, 4, 5]} />))).toBe(
      row(BAR_PRIMARY + toggleChip(BAR_GHOST_MARK)),
    );
    expect(
      legendOf(renderToStaticMarkup(<BarChart values={[1, 2, 3, 4]} ghost={[2, 3, 4, 5]} legendToggle={false} />)),
    ).toBe(row(BAR_PRIMARY + staticChip(BAR_GHOST_MARK, false)));
    expect(
      legendOf(
        renderToStaticMarkup(
          <BarChart values={[1, 2, 3, 4]} ghost={[2, 3, 4, 5]} legendToggle={false} ghostVisible={false} />,
        ),
      ),
    ).toBe(row(BAR_PRIMARY + staticChip(BAR_GHOST_MARK, true)));
  });

  it('подписи серий приходят от хоста, а не из легенды', () => {
    const html = legendOf(
      renderToStaticMarkup(
        <LineChart values={[1, 2, 3, 4]} ghost={[2, 3, 4, 5]} primaryLabel="Своё" ghostLabel="Год назад" />,
      ),
    );
    expect(html).toContain('>Своё</span>');
    expect(html).toContain('>Год назад</button>');
  });
});
