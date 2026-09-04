import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompactStatHeadline, StackedStat } from './CompareStat';

/**
 * D9 (аудит #554): три соседние S-карточки одного размера держали ТРИ разные композиции.
 *
 *   • «Ср. охват» печатал голое число — пары окон нет, DeltaPill отдавал null;
 *   • «Реакции» — число со стрелкой в той же строке;
 *   • «Вовлечённость» — число ПО ЦЕНТРУ, дельту строкой ниже и абзац описания.
 *
 * Ряд читался как три карточки разных типов. Здесь пришпилена одна анатомия: число и дельта на
 * одной базовой линии слева, слот дельты не молчит никогда, а пояснение уходит вниз.
 */

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('CompactStatHeadline — слот дельты', () => {
  it('нет прошлого окна → «— к пред.», а не пустота', () => {
    const html = renderToStaticMarkup(<CompactStatHeadline text="12,4K" delta={null} live />);
    // NBSP внутри — визуально одна лексема, поэтому сравниваем по нормализованному пробелу.
    expect(text(html).replace(/ /g, ' ')).toContain('— к пред.');
  });

  it('сравнили и без изменений → честный «0%», не молчание', () => {
    const html = renderToStaticMarkup(<CompactStatHeadline text="12,4K" delta={{ pct: 0, dir: 'flat' }} live />);
    expect(text(html)).toContain('0%');
    expect(text(html)).not.toContain('—');
  });

  it('есть движение → стрелка с процентом', () => {
    const html = renderToStaticMarkup(<CompactStatHeadline text="12,4K" delta={{ pct: 8.3, dir: 'up' }} live />);
    expect(text(html)).toContain('↑8.3%');
  });

  it('честные «п.п.» выигрывают у относительного процента', () => {
    const html = renderToStaticMarkup(
      <CompactStatHeadline text="28,9%" delta={{ pct: 8.3, dir: 'up' }} deltaText="+1,4 п.п." live />,
    );
    expect(text(html)).toContain('+1,4 п.п.');
    expect(text(html)).not.toContain('8.3%');
  });

  it('данных нет вовсе → слот молчит: «— к пред.» рядом с «—» было бы шумом', () => {
    const html = renderToStaticMarkup(<CompactStatHeadline text="—" delta={null} live={false} />);
    expect(text(html).replace(/ /g, ' ')).not.toContain('к пред.');
  });
});

describe('StackedStat — одна композиция с соседями по ряду', () => {
  const html = renderToStaticMarkup(
    <StackedStat text="28,9%" delta={{ pct: 4, dir: 'up' }} deltaText="+1,4 п.п." live note="Пояснение." />,
  );

  it('число и дельта стоят на одной базовой линии слева, без центрирования', () => {
    expect(html).toContain('flex items-baseline gap-2');
    expect(html).not.toContain('items-center');
    expect(html).not.toContain('text-center');
  });

  it('пояснение остаётся, но уходит вниз тихой строкой', () => {
    expect(text(html)).toContain('Пояснение.');
    expect(html).toContain('text-2xs');
  });

  it('дельта стоит В СТРОКЕ с числом, а не отдельной подписью «к прошлому периоду»', () => {
    expect(text(html)).toContain('+1,4 п.п.');
    expect(text(html)).not.toContain('к прошлому периоду');
  });
});

describe('дельта ниже разрешения печати', () => {
  it('«↑0.0%» не печатается: это заявка на движение, которую опровергает само число', () => {
    const html = renderToStaticMarkup(<CompactStatHeadline text="12,4K" delta={{ pct: 0.04, dir: 'up' }} live />);
    expect(text(html)).not.toContain('↑');
    // Сравнение БЫЛО — значит слот говорит «0%», а не «— к пред.».
    expect(text(html)).toContain('0%');
  });

  it('движение выше разрешения печатается как раньше', () => {
    const html = renderToStaticMarkup(<CompactStatHeadline text="12,4K" delta={{ pct: 0.06, dir: 'up' }} live />);
    expect(text(html)).toContain('↑0.1%');
  });
});
