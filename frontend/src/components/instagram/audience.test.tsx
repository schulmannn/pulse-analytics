import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IgOnline } from '@/api/schemas';
import { BestTimeHeatmap } from '@/components/instagram/audience';

const online = (value: Record<string, number>): IgOnline =>
  ({ data: [{ values: [{ end_time: '2026-01-05T07:00:00Z', value }] }] }) as unknown as IgOnline;

describe('BestTimeHeatmap', () => {
  it('вердикт стоит РАНЬШЕ сетки и называет оба конца шкалы', () => {
    const html = renderToStaticMarkup(<BestTimeHeatmap online={online({ '9': 40, '18': 120, '21': 80 })} />);

    expect(html.indexOf('data-slot="heatmap-verdict"')).toBeGreaterThan(-1);
    // Порядок в разметке = порядок чтения: ответ до 168 клеток доказательства.
    expect(html.indexOf('data-slot="heatmap-verdict"')).toBeLessThan(html.indexOf('data-heatmap-cell'));
    expect(html).toContain('18:00');
    expect(html).toContain('120 онлайн');
    expect(html).toContain('Тише всего');
    expect(html).toContain('9:00');
    expect(html).toContain('40 онлайн');
    // Строка-дубль под сеткой снята — тот же факт не печатается дважды.
    expect(html).not.toContain('лучший слот:');
  });

  it('одна ненулевая ячейка даёт пик без выдуманного затишья', () => {
    const html = renderToStaticMarkup(<BestTimeHeatmap online={online({ '0': 0, '18': 120 })} />);

    expect(html).toContain('Пик');
    expect(html).not.toContain('Тише всего');
  });

  it('пустая почасовая карта — карточка держит СВОЙ силуэт, а не полосу воздуха', () => {
    const html = renderToStaticMarkup(<BestTimeHeatmap online={online({ '0': 0, '1': 0 })} />);

    expect(html).toContain('data-slot="empty-ghost"');
    expect(html).toContain('data-ghost="bars"');
    // Причина осталась дословно той же, что печатал прежний абзац.
    expect(html).toContain('метрика доступна не всегда и требует 100+ подписчиков');
    expect(html).not.toContain('data-slot="heatmap-verdict"');
  });
});
