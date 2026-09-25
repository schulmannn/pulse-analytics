import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_BASIS_ALL_TIME } from '@/lib/delta';
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
  /**
   * ПЕРЕВЁРНУТ (R2). Раньше здесь пиналось «— к пред.» — и оно же было дефектом: слот ссылался на
   * «пред.», которого читатель НИГДЕ не видел (ни дат, ни числа), а ведущее тире читалось как сбой
   * загрузки. Контракт сменился: слот называет своё состояние словами и объясняет причину
   * подсказкой. Само требование «слот не молчит никогда» (D9) осталось нетронутым.
   */
  it('нет прошлого окна → «нет базы» с причиной, а не отсылка к невидимому «пред.»', () => {
    const html = renderToStaticMarkup(
      <CompactStatHeadline text="12,4K" delta={null} noBasisReason={NO_BASIS_ALL_TIME} live />,
    );
    const flat = text(html).replace(/\u00a0/g, ' ');
    expect(flat).toContain('нет базы');
    expect(flat).not.toContain('к пред.');
    expect(html).toContain(`title="${NO_BASIS_ALL_TIME}"`);
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


/**
 * R2 — ОСНОВАНИЕ ДЕЛЬТЫ ПО ХОВЕРУ. «↑12.3%» не проверить, не уходя со страницы: ни даты базы, ни
 * её числа рядом не было. Основание встаёт подсказкой (`title`) и дублируется для читалки —
 * `title` недоступен ни с клавиатуры, ни на тач.
 */
describe('CompactStatHeadline — основание дельты', () => {
  const basis = { label: '29 июл. – 4 авг.', value: '9.9k' };

  it('пилюля процента несёт «против …: …» и повторяет его для читалки', () => {
    const html = renderToStaticMarkup(
      <CompactStatHeadline text="12,4K" delta={{ pct: 12.3, dir: 'up' }} basis={basis} live />,
    );
    expect(html).toContain('title="против 29 июл. – 4 авг.: 9.9k"');
    expect(html).toContain('sr-only');
    expect(text(html)).toContain('↑12.3%');
  });

  it('готовая строка-дельта («п.п.», «+N») несёт то же основание — пилюли там нет', () => {
    const html = renderToStaticMarkup(
      <CompactStatHeadline text="28,9%" delta={{ pct: 8.3, dir: 'up' }} deltaText="+1,4 п.п." basis={basis} live />,
    );
    expect(html).toContain('title="против 29 июл. – 4 авг.: 9.9k"');
    expect(text(html)).toContain('+1,4 п.п.');
  });

  it('без основания атрибута нет вовсе — пустой title читалка озвучивает как шум', () => {
    const html = renderToStaticMarkup(
      <CompactStatHeadline text="12,4K" delta={{ pct: 12.3, dir: 'up' }} live />,
    );
    expect(html).not.toContain('title=');
    expect(html).not.toContain('sr-only');
  });

  it('рецепт слота ОДИН на все варианты — иначе подсказку пришлось бы вешать в каждый отдельно', () => {
    const recipe = 'shrink-0 text-xs font-medium tabular-nums text-muted-foreground';
    for (const html of [
      renderToStaticMarkup(<CompactStatHeadline text="1" delta={{ pct: 5, dir: 'up' }} live />),
      renderToStaticMarkup(<CompactStatHeadline text="1" delta={{ pct: 0, dir: 'flat' }} live />),
      renderToStaticMarkup(<CompactStatHeadline text="1" delta={null} live />),
      renderToStaticMarkup(<CompactStatHeadline text="1" delta={null} deltaText="+531" live />),
    ]) {
      expect(html).toContain(recipe);
    }
  });
});
