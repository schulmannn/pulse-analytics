import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { IgBreakdowns, IgOnline } from '@/api/schemas';
import { AudienceBlock, BestTimeHeatmap } from '@/components/instagram/audience';
import { IG_AUDIENCE_INFO, IG_DEMOGRAPHICS_EMPTY, IG_DEMOGRAPHICS_MIN_FOLLOWERS } from '@/lib/igMetrics';
import { PeriodProvider } from '@/lib/period';

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

/** Разрез follower_demographics в форме, в которой его отдаёт Graph API. */
const demographics = (dimension: string, results: Array<[string, number]>) => ({
  dimension_keys: [dimension],
  results: results.map(([key, value]) => ({ dimension_values: [key], value })),
});

const breakdownsOf = (
  ...groups: ReturnType<typeof demographics>[]
): IgBreakdowns =>
  ({
    data: [{ name: 'follower_demographics', total_value: { breakdowns: groups } }],
  }) as unknown as IgBreakdowns;

/** Карточки живут в сетке виджетов: им нужен роутер (drillTo) и период страницы. */
const audience = (breakdowns: IgBreakdowns | undefined, followers: number) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PeriodProvider>
        <AudienceBlock breakdowns={breakdowns} followers={followers} />
      </PeriodProvider>
    </MemoryRouter>,
  );

const countOf = (markup: string, needle: string) => markup.split(needle).length - 1;

describe('AudienceBlock — четыре равные карточки демографии', () => {
  const filled = breakdownsOf(
    demographics('age', [
      ['13-17', 40], ['18-24', 260], ['25-34', 300], ['35-44', 90],
      ['45-54', 60], ['55-64', 30], ['65+', 20],
    ]),
    demographics('gender', [['F', 500], ['M', 300]]),
    demographics('country', [['RU', 400], ['US', 250], ['DE', 150]]),
    demographics('city', [['Moscow, Moscow', 300], ['Berlin, Berlin', 120]]),
  );

  it('все четыре — ОДНОГО размера: разной ширины они читались бы как иерархия, которой нет', () => {
    const html = audience(filled, 1000);

    // При third их было три плюс одна: правило заполнения ряда честно растягивало четвёртую на
    // всю ширину, и «Топ городов» выходил втрое шире «Топ стран» при одинаковой природе разреза.
    expect(countOf(html, 'data-widget-size="half"')).toBe(4);
    expect(html).not.toContain('data-widget-size="third"');
  });

  it('у каждой карточки своя ⓘ с определением, а не только заголовок', () => {
    const html = audience(filled, 1000);

    for (const info of Object.values(IG_AUDIENCE_INFO)) {
      expect(html).toContain(`aria-label="Что такое «${info.title}»"`);
    }
    expect(countOf(html, 'aria-label="Что такое')).toBe(4);
  });

  it('охват демографии — примечание карточки «Возраст», а не абзац под сеткой', () => {
    // 800 из 1000 расписано по возрастам: оговорка обязана быть — и обязана стоять там, где
    // посчитана. Под сеткой одно число отвечало сразу за четыре разных знаменателя.
    const html = audience(filled, 1000);

    expect(html).toContain('data-breakdown-footnote');
    expect(html).toContain('≈80%');
    // Прежний абзац под сеткой снят: тот же факт не печатается дважды и не висит вне карточки.
    expect(html).not.toContain('Охвачено ≈');
  });

  it('полный охват — молчание: оговорка про недобор в пару процентов была бы шумом', () => {
    const html = audience(filled, 800);

    expect(html).not.toContain('data-breakdown-footnote');
  });

  it('пустая демография называет ПОРОГ, и одинаково на всех четырёх карточках', () => {
    // Раньше все четыре печатали «Нет данных за период» — и отправляли крутить период, от
    // которого снимок базы не зависит вовсе.
    const html = audience(undefined, 0);

    expect(countOf(html, IG_DEMOGRAPHICS_EMPTY.title)).toBe(4);
    expect(countOf(html, IG_DEMOGRAPHICS_EMPTY.reason)).toBe(4);
    expect(html).toContain(String(IG_DEMOGRAPHICS_MIN_FOLLOWERS));
    expect(html).not.toContain('Нет данных за период');
    // Каждая карточка держит СВОЙ силуэт: три рейтинга строк и одно кольцо долей.
    expect(countOf(html, 'data-ghost="rows"')).toBe(3);
    expect(countOf(html, 'data-ghost="ring"')).toBe(1);
  });
});
