import { describe, expect, it } from 'vitest';
import { buildIgWeekNarrative, buildWeekNarrative, narrativeToPlain, plural, pluralKpi, type NarrativeIgInput, type NarrativeInput } from '@/lib/narrative';

/** Intl ставит NBSP/узкий пробел в разрядах — тесты сравнивают по обычным пробелам. */
const norm = (s: string) => s.replace(/[  ]/g, ' ');
const day = (i: number) => `2026-06-${String(8 + i).padStart(2, '0')}`;
const mkSeries = (vals: number[]) => vals.map((v, i) => ({ day: day(i), v }));
const post = (title: string, views: number, re: number, erv: number, fw = 1): NarrativeInput['posts'][number] => ({
  title,
  views,
  reactions: re,
  forwards: fw,
  replies: 0,
  erv,
});

const base: NarrativeInput = {
  viewsDaily: mkSeries([980, 454, 463, 471, 467, 0, 417, 845, 381, 691, 314, 0, 242, 166]),
  posts: [post('Герой процесса', 380, 34, 10.3, 4), post('Обычный', 402, 11, 3.0), post('Ещё один', 440, 10, 2.5)],
  avgErv: 5.3,
  subsNow: 4749,
  subsD7: -27,
};

describe('buildWeekNarrative', () => {
  it('считает сдвиг недели и атрибутирует его неповторённому пику (не тишине — паузы равны)', () => {
    const plain = norm(narrativeToPlain(buildWeekNarrative(base)));
    expect(plain).toContain('2 639');
    expect(plain).toContain('↓19%'); // (2639−3252)/3252
    expect(plain).toContain('980');
    expect(plain).toContain('30% её суммы');
    expect(plain).not.toContain('тишина'); // по одному нулевому дню в обеих неделях — гейт молчит
  });

  it('не оставляет скрытый пробел перед точкой вокруг inline-спарка', () => {
    const nar = buildWeekNarrative(base);
    const segments = nar.paragraphs.flat();
    for (let i = 1; i < segments.length; i += 1) {
      if (segments[i]?.kind !== 'spark') continue;
      const before = segments[i - 1];
      expect(before?.kind).toBe('text');
      if (before?.kind === 'text') expect(before.text).not.toMatch(/\s$/u);
    }
  });

  it('атрибутирует тишине, когда пустых дней стало на 2+ больше', () => {
    const vals = [500, 500, 500, 500, 500, 500, 500, 700, 0, 0, 0, 700, 0, 500];
    const plain = norm(narrativeToPlain(buildWeekNarrative({ ...base, viewsDaily: mkSeries(vals) })));
    expect(plain).toContain('тишина');
    expect(plain).toContain('4 дня без публикаций');
  });

  it('герой рождается только при лифте ERV ≥ ×1.6 и опирает на себя совет', () => {
    const plain = norm(narrativeToPlain(buildWeekNarrative(base)));
    expect(plain).toContain('Герой недели');
    expect(plain).toContain('10.3%');
    expect(plain).toContain('в 1.9 раза выше нормы');
    expect(plain).toContain('34 реакции');
    expect(plain).toContain('повторить');

    const weak = { ...base, posts: base.posts.map((p) => ({ ...p, erv: 6 })) };
    const plainWeak = norm(narrativeToPlain(buildWeekNarrative(weak)));
    expect(plainWeak).not.toContain('Герой недели');
    expect(plainWeak).not.toContain('повторить'); // совет без находки не выдумывается
  });

  it('чип героя режет длинный заголовок по границе слова, не посреди («…присо…» не рождается)', () => {
    const heroChip = (title: string) => {
      const posts = [post(title, 380, 34, 10.3, 4), post('Обычный', 402, 11, 3.0), post('Ещё один', 440, 10, 2.5)];
      const chip = buildWeekNarrative({ ...base, posts }).paragraphs.flat().find((s) => s.kind === 'post');
      return chip && chip.kind === 'post' ? chip.text : '';
    };
    expect(heroChip('Сливочный забег и подарки от брендов 18 июля присоединяйтесь к празднику')).toBe(
      '«Сливочный забег и подарки от брендов 18 июля…»',
    );
    // Хвостовая пунктуация на месте реза не остаётся перед «…».
    expect(heroChip('Сливочный забег и подарки от брендов 18 июля, присоединяйтесь')).toBe(
      '«Сливочный забег и подарки от брендов 18 июля…»',
    );
    // Пробел раньше 30-й позиции — откат съел бы полстроки: остаётся жёсткий рез по 52.
    expect(heroChip(`Слово ${'а'.repeat(60)}`)).toBe(`«Слово ${'а'.repeat(46)}…»`);
    // Короткий заголовок — без «…».
    expect(heroChip('Герой процесса')).toBe('«Герой процесса»');
  });

  it('рекорд месяца упоминается только старше обеих недель', () => {
    const withOld = mkSeries([100, 100, 100, 2000, 100, 100, 100, ...Array(7).fill(120), ...Array(7).fill(110), ...Array(7).fill(100)]);
    const plain = norm(narrativeToPlain(buildWeekNarrative({ ...base, viewsDaily: withOld })));
    expect(plain).toContain('Рекорд месяца');
    expect(plain).toContain('2 000');
  });

  it('без полного окна сравнения сдвиг не рождается, но база остаётся', () => {
    const nar = buildWeekNarrative({ ...base, viewsDaily: mkSeries([100, 200, 300]) });
    const plain = norm(narrativeToPlain(nar));
    expect(plain).not.toContain('предыдущей');
    expect(plain).toContain('4 749');
  });

  it('тихая неделя даёт короткий честный текст', () => {
    const nar = buildWeekNarrative({ viewsDaily: mkSeries([0, 0, 0, 0, 0, 0, 0]), posts: [], avgErv: null, subsNow: 4749, subsD7: -5 });
    expect(nar.quiet).toBe(true);
    expect(norm(narrativeToPlain(nar))).toContain('Тихая неделя');
  });

  it('каждое число-сегмент несёт drill-ссылку на страницу метрики', () => {
    const nar = buildWeekNarrative(base);
    const numbers = nar.paragraphs.flat().filter((s) => s.kind === 'number');
    expect(numbers.length).toBeGreaterThan(3);
    for (const s of numbers) expect(s.kind === 'number' && s.to).toMatch(/^\/metrics\//);
  });

  it('kpi-аббревиатура тянет родительный: «13.2k просмотров», не «просмотра»', () => {
    const vals = [3000, 3000, 3000, 3000, 3000, 3000, 3000, 2000, 2000, 2000, 2000, 2000, 2000, 1192]; // cur = 13 192
    const plain = norm(narrativeToPlain(buildWeekNarrative({ ...base, viewsDaily: mkSeries(vals) })));
    expect(plain).toContain('13.2k просмотров');
  });
});

describe('Instagram + кросс-сетевой контраст', () => {
  /** prev-неделя → cur-неделя охвата + дневные чистые подписки текущей недели. */
  const ig = (
    prev: number[],
    cur: number[],
    follows: number[] = [],
    followersNow: number | null = 1024,
    reachWeek?: NarrativeIgInput['reachWeek'],
  ) => ({
    reachDaily: [...prev, ...cur].map((v, i) => ({ day: day(i), v })),
    reachWeek,
    followsDaily: follows.map((v, i) => ({ day: day(7 + i), v })),
    followersNow,
  });
  const flat600 = Array(7).fill(600) as number[];

  it('IG-абзац рождается с полными окнами: охват, движение базы, drill на ig-страницы', () => {
    const inp = { ...base, ig: ig(flat600, Array(7).fill(648), [2, 3, -1, 4, 0, 1, 2]) };
    const nar = buildWeekNarrative(inp);
    const plain = norm(narrativeToPlain(nar));
    expect(plain).toContain('Instagram за ту же неделю');
    expect(plain).toContain('4 536'); // 648×7 — сумма по дням, как headline /metrics/ig-reach (7д)
    expect(plain).toContain('База там набрала 11'); // Σ дневных чистых подписок
    expect(plain).toContain('1 024');
    const links = nar.paragraphs.flat().filter((s) => s.kind === 'number').map((s) => (s.kind === 'number' ? s.to : ''));
    expect(links).toContain('/metrics/ig-reach');
    expect(links).toContain('/metrics/ig-follows');
  });

  it('IG-абзац берёт число охвата и WoW из reachWeek, а spark оставляет дневным', () => {
    const inp = { ...base, ig: ig(flat600, Array(7).fill(1000), [], 1024, { cur: 7207, prev: 6000, hasCur: true, hasPrev: true }) };
    const nar = buildWeekNarrative(inp);
    const plain = norm(narrativeToPlain(nar));
    expect(plain).toContain('7 207');
    expect(plain).toContain('↑20%');
    expect(plain).not.toContain('7 000');
    // IG reach spark — ПОСЛЕДНИЙ spark (TG-views spark идёт первым в объединённом рассказе).
    const spark = nar.paragraphs.flat().filter((s) => s.kind === 'spark').at(-1);
    expect(spark && spark.kind === 'spark' ? spark.values.slice(-7) : []).toEqual(Array(7).fill(1000));
  });

  it('контраст при расхождении: TG вниз, IG вверх → «просадка касается только Telegram»', () => {
    const plain = norm(narrativeToPlain(buildWeekNarrative({ ...base, ig: ig(flat600, Array(7).fill(680)) })));
    expect(plain).toContain('Сети разошлись');
    expect(plain).toContain('касается только Telegram');
  });

  it('контраст при синхронном минусе: «обе сети ниже»', () => {
    const plain = norm(narrativeToPlain(buildWeekNarrative({ ...base, ig: ig(flat600, Array(7).fill(500)) })));
    expect(plain).toContain('обе сети ниже прошлой недели');
    expect(plain).not.toContain('разошлись');
  });

  it('слабое движение IG (<±3%) трендом не объявляется — контраста нет', () => {
    const plain = norm(narrativeToPlain(buildWeekNarrative({ ...base, ig: ig(flat600, Array(7).fill(606)) })));
    expect(plain).toContain('Instagram за ту же неделю');
    expect(plain).not.toContain('разошлись');
    expect(plain).not.toContain('Движение общее');
  });

  it('IG-герой рождается по лифту ≥×1.6 и несёт permalink-чип', () => {
    const withHero = {
      ...ig(flat600, Array(7).fill(648)),
      mediaWeek: [
        { title: 'Закат над мастерской', erv: 8.1, permalink: 'https://instagram.com/p/abc' },
        { title: 'Обычный пост', erv: 2.0, permalink: null },
        { title: 'Ещё один', erv: 1.5, permalink: null },
      ],
      avgMediaErv: 3.8,
    };
    const nar = buildWeekNarrative({ ...base, ig: withHero });
    const plain = norm(narrativeToPlain(nar));
    expect(plain).toContain('Герой там');
    expect(plain).toContain('8.1%');
    expect(plain).toContain('в 2.1 раза выше нормы аккаунта');
    const chip = nar.paragraphs.flat().find((s) => s.kind === 'post' && s.href);
    expect(chip && chip.kind === 'post' ? chip.href : null).toBe('https://instagram.com/p/abc');
  });

  it('IG-герой молчит без лифта или без трёх медиа недели', () => {
    const igBase = ig(flat600, Array(7).fill(648));
    const weak = {
      ...igBase,
      mediaWeek: [
        { title: 'a', erv: 4.0, permalink: null },
        { title: 'b', erv: 3.9, permalink: null },
        { title: 'c', erv: 3.5, permalink: null },
      ],
      avgMediaErv: 3.8,
    };
    expect(norm(narrativeToPlain(buildWeekNarrative({ ...base, ig: weak })))).not.toContain('Герой там');
    const few = {
      ...igBase,
      mediaWeek: [
        { title: 'a', erv: 9, permalink: null },
        { title: 'b', erv: 1, permalink: null },
      ],
      avgMediaErv: 3.8,
    };
    expect(norm(narrativeToPlain(buildWeekNarrative({ ...base, ig: few })))).not.toContain('Герой там');
  });

  it('без полного окна охвата IG-абзац не рождается', () => {
    const short = { reachDaily: Array(10).fill(0).map((_, i) => ({ day: day(i), v: 500 })), followsDaily: [], followersNow: 1024 };
    const plain = norm(narrativeToPlain(buildWeekNarrative({ ...base, ig: short })));
    expect(plain).not.toContain('Instagram');
  });

  it('тихая TG-неделя не глушит живой Instagram («за неделю», без контраста)', () => {
    const nar = buildWeekNarrative({
      viewsDaily: mkSeries([0, 0, 0, 0, 0, 0, 0]),
      posts: [],
      avgErv: null,
      subsNow: 4749,
      subsD7: -5,
      ig: ig(flat600, Array(7).fill(680)),
    });
    expect(nar.quiet).toBe(true);
    const plain = norm(narrativeToPlain(nar));
    expect(plain).toContain('Тихая неделя');
    expect(plain).toContain('Instagram за неделю');
    expect(plain).not.toContain('за ту же');
    expect(plain).not.toContain('разошлись');
  });
});

describe('buildIgWeekNarrative — IG-фокусный рассказ (виджет «IG · Неделя»)', () => {
  const igInput = (over: Partial<NarrativeIgInput> = {}): NarrativeIgInput => ({
    reachDaily: mkSeries(Array(14).fill(0).map((_, i) => (i < 7 ? 600 : 680))), // prev 600 → cur 680 (+13%)
    followsDaily: mkSeries([0, 0, 0, 0, 0, 0, 0, 2, 3, -1, 4, 0, 1, 2]).slice(-7),
    followersNow: 12480,
    mediaWeek: [],
    avgMediaErv: null,
    ...over,
  });

  it('Instagram ведёт: охват-сдвиг + Δ + движение базы, drill на /metrics/ig-*', () => {
    const plain = norm(narrativeToPlain(buildIgWeekNarrative(igInput())));
    expect(plain).toContain('Охват за неделю — 4 760'); // 680×7, headline страницы ig-reach 7д
    expect(plain).toContain('↑13'); // (4760−4200)/4200
    expect(plain).toContain('База выросла на 11'); // Σ дневных нетто-подписок последней недели
    expect(plain).toContain('12.5k');
    const links = buildIgWeekNarrative(igInput()).paragraphs.flat().filter((s) => s.kind === 'number');
    for (const s of links) expect(s.kind === 'number' && s.to).toMatch(/^\/metrics\/ig-/);
  });

  it('при reachWeek охват и WoW берутся из 7-дневного дедуп-окна, не из суммы reachDaily', () => {
    const plain = norm(narrativeToPlain(buildIgWeekNarrative(igInput({
      reachDaily: mkSeries(Array(14).fill(0).map((_, i) => (i < 7 ? 600 : 1000))),
      reachWeek: { cur: 7207, prev: 6000, hasCur: true, hasPrev: true },
    }))));
    expect(plain).toContain('Охват за неделю — 7 207');
    expect(plain).toContain('↑20%');
    expect(plain).not.toContain('7 000');
  });

  it('IG-герой недели рождается при лифте ERV ≥ ×1.6 (тот же гейт, что у TG)', () => {
    const withHero = igInput({
      mediaWeek: [
        { title: 'Процесс саше', erv: 9.2, permalink: 'https://instagram.com/p/x' },
        { title: 'Обычный', erv: 3.0, permalink: null },
        { title: 'Ещё', erv: 2.5, permalink: null },
      ],
      avgMediaErv: 4.0,
    });
    const plain = norm(narrativeToPlain(buildIgWeekNarrative(withHero)));
    expect(plain).toContain('Герой недели');
    expect(plain).toContain('9.2%');
    expect(plain).toContain('в 2.3 раза выше нормы аккаунта');

    const weak = igInput({ mediaWeek: withHero.mediaWeek!.map((m) => ({ ...m, erv: 5 })), avgMediaErv: 4.0 });
    expect(norm(narrativeToPlain(buildIgWeekNarrative(weak)))).not.toContain('Герой недели');
  });

  it('без полного окна охвата сдвиг не рождается, но база остаётся', () => {
    const plain = norm(narrativeToPlain(buildIgWeekNarrative(igInput({ reachDaily: mkSeries([100, 200, 300]) }))));
    expect(plain).not.toContain('Охват за неделю');
    expect(plain).toContain('12.5k');
  });

  it('совсем мало данных → тихий честный текст, не вода', () => {
    const nar = buildIgWeekNarrative({ reachDaily: [], followsDaily: [], followersNow: null, mediaWeek: [], avgMediaErv: null });
    expect(nar.quiet).toBe(true);
    expect(norm(narrativeToPlain(nar))).toContain('мало данных Instagram');
  });

  it('ig=null (не подключён) → тихо, без падения', () => {
    expect(buildIgWeekNarrative(null).quiet).toBe(true);
  });
});

describe('plural', () => {
  it('склоняет по-русски', () => {
    expect(plural(1, 'реакция', 'реакции', 'реакций')).toBe('реакция');
    expect(plural(34, 'реакция', 'реакции', 'реакций')).toBe('реакции');
    expect(plural(27, 'подписчика', 'подписчиков', 'подписчиков')).toBe('подписчиков');
    expect(plural(11, 'день', 'дня', 'дней')).toBe('дней');
  });

  it('pluralKpi: до порога аббревиатуры — по последней цифре, после — родительный', () => {
    expect(pluralKpi(2639, 'просмотр', 'просмотра', 'просмотров')).toBe('просмотров');
    expect(pluralKpi(9863, 'просмотр', 'просмотра', 'просмотров')).toBe('просмотра'); // ещё полная запись
    expect(pluralKpi(12683, 'просмотр', 'просмотра', 'просмотров')).toBe('просмотров'); // «12.7k …»
  });
});
