import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HeatmapVerdict } from '@/components/HeatmapVerdict';

const PEAK = { day: 'Пн', hour: 18, value: '1.2k онлайн' };
const QUIET = { day: 'Сб', hour: 4, value: '120 онлайн' };

describe('HeatmapVerdict', () => {
  it('без пика не печатает ничего', () => {
    expect(renderToStaticMarkup(<HeatmapVerdict peak={null} quiet={QUIET} />)).toBe('');
  });

  it('без затишья остаётся одна половина строки', () => {
    const html = renderToStaticMarkup(<HeatmapVerdict peak={PEAK} quiet={null} />);

    expect(html).toContain('Пик');
    expect(html).toContain('Пн 18:00');
    expect(html).toContain('1.2k онлайн');
    expect(html).not.toContain('Тише всего');
  });

  it('со затишьем печатает оба конца шкалы', () => {
    const html = renderToStaticMarkup(<HeatmapVerdict peak={PEAK} quiet={QUIET} />);

    expect(html).toContain('Тише всего');
    expect(html).toContain('Сб 4:00');
    expect(html).toContain('120 онлайн');
  });

  it('затишье прячется ТОЛЬКО в узком тайле, а не всюду, где контейнера нет', () => {
    const html = renderToStaticMarkup(<HeatmapVerdict peak={PEAK} quiet={QUIET} />);

    // `tile-narrow:hidden` — «по умолчанию видно, прячем в тесном слоте». Обратная запись
    // (`hidden tile-wide:inline`) на страницах метрик и в развороте карточки, где контейнера
    // `tile` не существует, спрятала бы затишье насовсем: запрос к отсутствующему контейнеру
    // ложен всегда.
    expect(html).toContain('tile-narrow:hidden');
    expect(html).not.toMatch(/class="[^"]*\bhidden\b[^"]*tile-wide:/);
  });

  it('оба слота набраны одним каноном: 500 и tabular-nums, без цвета', () => {
    const html = renderToStaticMarkup(<HeatmapVerdict peak={PEAK} quiet={QUIET} />);

    const slots = html.match(/font-medium tabular-nums text-foreground/g) ?? [];
    expect(slots).toHaveLength(2);
    // Оценочный цвет в продукте занят дельтой рейла сравнения — вердикту он не положен.
    expect(html).not.toMatch(/text-(?:verdant|destructive|primary)\b/);
    expect(html).toContain('data-slot="heatmap-verdict"');
  });
});
