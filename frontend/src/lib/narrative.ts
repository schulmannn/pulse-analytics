import { fmt } from '@/lib/format';

/**
 * НАРРАТИВНЫЙ СЛОЙ — движок находок + сборка «текста-с-данными» (roadmap card, фаза 1).
 *
 * Правила (дизайн-док, тон утверждён владельцем на реальных данных @bynotem):
 * - Находка РОЖДАЕТСЯ только когда её вклад считаем; мало данных → находки нет, никогда не
 *   выдуманных причин. Совет в финале — только из подтверждённой находки.
 * - Детерминированно, без LLM: шаблоны с честными гейтами и русской плюрализацией.
 * - Выход — типизированные СЕГМЕНТЫ (не строки): рендерер на Обзоре рисует числа-ссылки
 *   (drill-контракт), Δ-пилюли, спарклайн-в-строке и чип поста; plain-рендер тех же сегментов
 *   даёт TG-дайджест. Один источник — две поверхности.
 */

export type NarrativeSeg =
  | { kind: 'text'; text: string }
  /** Число в drill-контракте — `to` ведёт на страницу метрики (числа сходятся с ней 1-в-1). */
  | { kind: 'number'; text: string; to?: string }
  /** Знаковая дельта-пилюля; pct со знаком (минус = вниз). */
  | { kind: 'delta'; pct: number }
  /** Спарклайн-в-строке — ряд как есть (обе недели), рендерер сам масштабирует. */
  | { kind: 'spark'; values: number[] }
  /** Чип поста — открывает карточку поста; postIndex указывает в input.posts. */
  | { kind: 'post'; text: string; postIndex: number };

export type NarrativeParagraph = NarrativeSeg[];

export interface NarrativePost {
  /** Заголовок/первые слова поста (для чипа). */
  title: string;
  views: number;
  reactions: number;
  forwards: number;
  replies: number;
  /** ERV, % — вовлечённость на просмотр этого поста. */
  erv: number;
}

export interface NarrativeInput {
  /** Дневная серия просмотров, СТАРЫЕ → НОВЫЕ; day = ISO. Может быть пустой (нет graphs). */
  viewsDaily: { day: string; v: number }[];
  /** Посты текущего окна (неделя), любые порядком. */
  posts: NarrativePost[];
  /** Средний ERV канала за окно сравнения (норма для лифта героя). */
  avgErv: number | null;
  /** Текущая база подписчиков (memberCount | последний уровень архива). */
  subsNow: number | null;
  /** Δ подписчиков за 7 дней (из дневного архива); null = архив короче. */
  subsD7: number | null;
}

export interface WeekNarrative {
  paragraphs: NarrativeParagraph[];
  /** Тихая неделя: ни постов, ни просмотров — короткий честный текст вместо воды. */
  quiet: boolean;
}

const t = (text: string): NarrativeSeg => ({ kind: 'text', text });
const n = (text: string, to?: string): NarrativeSeg => ({ kind: 'number', text, to });

/** Русская плюрализация: plural(34, 'реакция', 'реакции', 'реакций') → «реакции». */
export function plural(count: number, one: string, few: string, many: string): string {
  const m10 = Math.abs(count) % 10;
  const m100 = Math.abs(count) % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** ×N-лифт без хвоста «.0» («в 1.9 раза» / «в 3 раза»). */
const lift = (x: number) => x.toFixed(1).replace(/\.0$/, '');

export function buildWeekNarrative(inp: NarrativeInput): WeekNarrative {
  const paragraphs: NarrativeParagraph[] = [];
  const series = inp.viewsDaily;
  const last7 = series.slice(-7);
  const prev7 = series.slice(-14, -7);
  const curSum = sum(last7.map((p) => p.v));
  const prevSum = sum(prev7.map((p) => p.v));

  // Тихая неделя: честные две строки, не вода.
  if (inp.posts.length === 0 && curSum === 0) {
    const p: NarrativeParagraph = [t('Тихая неделя: постов не было, просмотры на нуле.')];
    if (inp.subsNow != null && inp.subsD7 != null && inp.subsD7 !== 0) {
      p.push(
        t(' База за это время '),
        t(inp.subsD7 < 0 ? 'потеряла ' : 'набрала '),
        n(fmt.num(Math.abs(inp.subsD7)), '/metrics/subscribers'),
        t(` ${plural(Math.abs(inp.subsD7), 'подписчика', 'подписчиков', 'подписчиков')} — каналы теряют и в паузах.`),
      );
    }
    return { paragraphs: [p], quiet: true };
  }

  // ── A. Сдвиг недели (гейт: есть оба полных окна) ──────────────────────────────────────────
  if (last7.length === 7 && prev7.length === 7 && prevSum > 0) {
    const pct = ((curSum - prevSum) / prevSum) * 100;
    const p: NarrativeParagraph = [
      t('За неделю канал собрал '),
      n(fmt.kpi(curSum), '/metrics/views'),
      t(` ${plural(curSum, 'просмотр', 'просмотра', 'просмотров')} — на `),
      { kind: 'delta', pct },
      t(` ${pct < 0 ? 'ниже' : 'выше'} предыдущей `),
      { kind: 'spark', values: series.slice(-14).map((x) => x.v) },
      t('. '),
    ];

    // Атрибуция — только считаемая. Приоритет: разница в тишине; иначе неповторённый пик.
    const silentCur = last7.filter((x) => x.v === 0).length;
    const silentPrev = prev7.filter((x) => x.v === 0).length;
    const peakPrev = prev7.reduce((a, b) => (b.v > a.v ? b : a));
    const peakShare = Math.round((peakPrev.v / prevSum) * 100);
    const peakUnmatched = pct < 0 && peakPrev.v > Math.max(...last7.map((x) => x.v));
    if (pct < 0 && silentCur >= silentPrev + 2) {
      p.push(
        t(
          `Главный вклад в разницу — тишина: ${silentCur} ${plural(silentCur, 'день', 'дня', 'дней')} без публикаций против ${silentPrev || 'нуля'} неделей раньше. `,
        ),
      );
    } else if (peakUnmatched && peakShare >= 25) {
      p.push(
        t(`Разницу почти целиком объясняет один день: ${fmt.day(peakPrev.day)} прошлой недели дал `),
        n(fmt.kpi(peakPrev.v), '/metrics/views'),
        t(` — ${peakShare}% её суммы, и в этот раз такого пика не случилось. `),
      );
    }

    // Рекорд месяца — отдельным предложением и ТОЛЬКО если он старше обеих недель
    // (чест-гейт из прототипа: аномалия месяца не выдаёт себя за событие недели).
    if (series.length >= 21) {
      const anom = series.reduce((a, b) => (b.v > a.v ? b : a));
      const anomIdx = series.findIndex((x) => x.day === anom.day);
      const nz = series.filter((x) => x.v > 0).map((x) => x.v);
      const mean = sum(nz) / Math.max(nz.length, 1);
      const sd = Math.sqrt(sum(nz.map((v) => (v - mean) ** 2)) / Math.max(nz.length, 1));
      if (anomIdx < series.length - 14 && sd > 0 && (anom.v - mean) / sd >= 2.2) {
        p.push(t(`Рекорд месяца при этом старше: ${fmt.day(anom.day)}, `), n(fmt.kpi(anom.v), '/metrics/views'), t(' за день.'));
      }
    }
    paragraphs.push(p);
  }

  // ── B. Герой недели (гейт: ≥3 постов и лифт ERV ≥ ×1.6 от нормы) ──────────────────────────
  let hero: { post: NarrativePost; idx: number; ervLift: number } | null = null;
  if (inp.posts.length >= 3 && inp.avgErv != null && inp.avgErv > 0) {
    const idx = inp.posts.reduce((best, p, i) => (p.erv > inp.posts[best].erv ? i : best), 0);
    const post = inp.posts[idx];
    const ervLift = post.erv / inp.avgErv;
    if (ervLift >= 1.6) {
      hero = { post, idx, ervLift };
      const reTotal = sum(inp.posts.map((p) => p.reactions));
      const reShare = reTotal > 0 ? Math.round((post.reactions / reTotal) * 100) : 0;
      paragraphs.push([
        t('Герой недели — '),
        { kind: 'post', text: `«${post.title.slice(0, 52)}…»`, postIndex: idx },
        t(': вовлечённость '),
        n(`${post.erv.toFixed(1)}%`, '/metrics/er'),
        t(` на просмотр — в ${lift(ervLift)} раза выше нормы канала, `),
        n(String(post.reactions), '/metrics/reactions'),
        t(
          ` ${plural(post.reactions, 'реакция', 'реакции', 'реакций')}${reShare > 0 ? ` (${reShare}% недельных)` : ''} и ${post.forwards} ${plural(post.forwards, 'репост', 'репоста', 'репостов')}.`,
        ),
      ]);
    }
  }

  // ── S. База подписчиков + совет из подтверждённой находки ─────────────────────────────────
  if (inp.subsNow != null && inp.subsD7 != null) {
    const d = inp.subsD7;
    const p: NarrativeParagraph = [];
    if (d !== 0) {
      p.push(
        t(d < 0 ? 'База просела на ' : 'База выросла на '),
        n(fmt.num(Math.abs(d)), '/metrics/subscribers'),
        t(` ${plural(Math.abs(d), 'подписчика', 'подписчиков', 'подписчиков')} `),
        { kind: 'delta', pct: (d / Math.max(inp.subsNow - d, 1)) * 100 },
        t(' — до '),
        n(fmt.kpi(inp.subsNow), '/metrics/subscribers'),
        t('. '),
      );
    } else {
      p.push(t('База держится на '), n(fmt.kpi(inp.subsNow), '/metrics/subscribers'), t(' без движения. '));
    }
    if (hero) {
      p.push(
        t(
          `Проверенный рычаг недели один: формат героя держит вовлечённость в ${lift(hero.ervLift)} раза выше нормы — есть смысл повторить его в ближайшие дни.`,
        ),
      );
    }
    paragraphs.push(p);
  }

  return { paragraphs, quiet: false };
}

/** Plain-рендер тех же сегментов — TG-дайджест и любой текстовый контекст. */
export function narrativeToPlain(nar: WeekNarrative): string {
  return nar.paragraphs
    .map((p) =>
      p
        .map((s) => {
          if (s.kind === 'text' || s.kind === 'number' || s.kind === 'post') return s.text;
          if (s.kind === 'delta') return `${s.pct < 0 ? '↓' : '↑'}${Math.abs(s.pct).toFixed(Math.abs(s.pct) < 10 ? 1 : 0)}%`;
          return '';
        })
        .join('')
        .replace(/\s+([.,])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .join('\n\n');
}
