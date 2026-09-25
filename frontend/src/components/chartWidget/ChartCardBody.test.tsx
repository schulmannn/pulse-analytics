import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChartCardBody } from './ChartCardBody';
import { WidgetSizeContext } from '@/lib/widgetSize';

/**
 * ВТОРИЧНОЕ ЧИСЛО ГЕРОЯ (R8, референс Mercury Insights / Resend Metrics).
 *
 * Герой отвечает «сколько всего», а следующий вопрос читателя — «это много или мало за обычный
 * день». Ответ до сих пор жил только в тултипе графика, то есть был недоступен без мыши. Вторая
 * цифра встаёт в колонку чисел под дельтой — но НЕ везде: в S-карточке (third) колонка и так
 * несёт число, дельту и «Мин · Макс», и четвёртая строка выдавила бы их за нижнюю кромку.
 *
 * Гейт по РАЗМЕРУ, а не по ширине окна: размер карточки выбирает владелец (widgetPrefsStore), и
 * тело обязано подчиняться его выбору, а не догадке о вьюпорте. Контейнерный запрос
 * `tile-narrow:` стоит рядом ВТОРЫМ слоем — он ловит узкий слот там, где размер формально half.
 */
const render = (secondary: { label: string; value: string } | undefined, size: 'third' | 'half' | 'full') =>
  renderToStaticMarkup(
    <WidgetSizeContext.Provider value={size}>
      <ChartCardBody value="1.2M" secondary={secondary}>
        {null}
      </ChartCardBody>
    </WidgetSizeContext.Provider>,
  );

const SECONDARY = { label: 'в среднем за день', value: '39.5k' };

describe('ChartCardBody — вторичное число рядом с главным', () => {
  it('в half печатается и число, и его подпись', () => {
    const html = render(SECONDARY, 'half');
    expect(html).toContain('39.5k');
    expect(html).toContain('в среднем за день');
  });

  it('в third вторичного числа нет — в S-карточке для него нет строки', () => {
    const html = render(SECONDARY, 'third');
    expect(html).not.toContain('39.5k');
    expect(html).not.toContain('в среднем за день');
    // Главное число при этом на месте: скрывается добавка, а не анатомия.
    expect(html).toContain('data-kpi-value');
  });

  it('без пропа разметка прежняя — слот не резервируется пустым', () => {
    expect(render(undefined, 'half')).not.toContain('data-chart-card-secondary');
  });

  it('число набрано KpiValue, а не строкой классов на месте', () => {
    // Рецепт числа живёт в одном компоненте (гейт kpi-number-recipe-retyped); крюк для проверки —
    // data-kpi-value, потому что цепляться за сами классы рецепта запрещено.
    const html = render(SECONDARY, 'half');
    const secondary = html.slice(html.indexOf('data-chart-card-secondary'));
    expect(secondary).toContain('data-kpi-value');
  });

  it('вторичное число НЕ морфится — барабан цифр остаётся привилегией героя', () => {
    // Морф (KpiNumber) — канон ГЕРОЙСКОГО числа карточки (решение владельца 2026-08-18). Два
    // барабана в одной строке — это два движения на одном взгляде; вторая цифра печатается снапом,
    // то есть текстом прямо внутри контейнера KpiValue.
    const html = render(SECONDARY, 'half');
    const secondary = html.slice(html.indexOf('data-chart-card-secondary'));
    expect(secondary).toMatch(/data-kpi-value[^>]*>39\.5k</);
  });
});
