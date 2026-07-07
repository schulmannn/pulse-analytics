import { describe, expect, it } from 'vitest';
import { buildWeekNarrative, narrativeToPlain, plural, type NarrativeInput } from '@/lib/narrative';

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
});

describe('plural', () => {
  it('склоняет по-русски', () => {
    expect(plural(1, 'реакция', 'реакции', 'реакций')).toBe('реакция');
    expect(plural(34, 'реакция', 'реакции', 'реакций')).toBe('реакции');
    expect(plural(27, 'подписчика', 'подписчиков', 'подписчиков')).toBe('подписчиков');
    expect(plural(11, 'день', 'дня', 'дней')).toBe('дней');
  });
});
