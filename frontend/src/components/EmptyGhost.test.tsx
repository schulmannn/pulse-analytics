import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_GHOST_INK, EmptyGhostShape, type EmptyGhost } from '@/components/EmptyGhost';

const KINDS: EmptyGhost[] = ['line', 'bars', 'rows', 'ring'];

describe('EmptyGhost — призрак формы пустой карточки', () => {
  it('прячет все четыре силуэта от скринридера: форма ничего не сообщает, сообщает текст рядом', () => {
    for (const kind of KINDS) {
      const html = renderToStaticMarkup(<EmptyGhostShape kind={kind} />);
      expect(html, kind).toContain('<svg');
      expect(html, kind).toContain('aria-hidden="true"');
      expect(html, kind).toContain('focusable="false"');
      // IE-наследие focusable + отсутствие роли: силуэт не должен попадать ни в дерево
      // доступности, ни в обход табом — иначе пустая карточка получает «пустой» стоп.
      expect(html, kind).not.toContain('role="img"');
    }
  });

  it('не анимируется ни в одном виде — иначе призрак неотличим от скелетона загрузки', () => {
    // Единственное, что разводит два состояния глазом: скелетон мерцает и молчит, призрак
    // статичен и всегда подписан. Любой animate-* здесь стирает эту границу.
    for (const kind of KINDS) {
      const html = renderToStaticMarkup(<EmptyGhostShape kind={kind} />);
      expect(html, kind).not.toMatch(/animate-/);
      expect(html, kind).not.toContain('<animate');
    }
  });

  it('красит все виды одной альфой — той, которую читает scripts/contrast-tokens.mjs', () => {
    // Класс — литерал, а не собранная строка: Tailwind сканирует исходники, а гейт контраста
    // вытаскивает из этого же литерала альфу. Разъехаться коду и гейту физически негде.
    expect(EMPTY_GHOST_INK).toBe('text-muted-foreground/25');
    for (const kind of KINDS) {
      expect(renderToStaticMarkup(<EmptyGhostShape kind={kind} />), kind).toContain(EMPTY_GHOST_INK);
    }
  });

  it('растянутые силуэты держат non-scaling-stroke, а кольцо остаётся кругом', () => {
    // Канон CLAUDE.md: viewBox + preserveAspectRatio="none" тянет неравномерно, и обводка
    // «размазывается» без vector-effect. Кольцу же неравномерность запрещена в принципе —
    // круг стал бы эллипсом, поэтому оно единственное едет на meet и без vector-effect.
    const line = renderToStaticMarkup(<EmptyGhostShape kind="line" />);
    expect(line).toContain('vector-effect="non-scaling-stroke"');
    expect(line).toContain('preserveAspectRatio="none"');

    const ring = renderToStaticMarkup(<EmptyGhostShape kind="ring" />);
    expect(ring).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(ring).not.toContain('vector-effect');
  });

  it('рисует контуром, а не заливкой — иначе это график «в тумане», а не его призрак', () => {
    // Залитые столбцы и строки при альфе 0.25 — тот же объект, что и данные, только тусклее, и
    // одновременно копия рядов скелетона загрузки: обе границы стираются разом. Контур говорит
    // ровно то, что должен: форма обещана, содержимого нет.
    for (const kind of KINDS) {
      const html = renderToStaticMarkup(<EmptyGhostShape kind={kind} />);
      expect(html, kind).not.toContain('fill="currentColor"');
      expect(html, kind).toContain('stroke="currentColor"');
    }
  });

  it('линия симметрична: у призрака нет наклона, который можно принять за тренд', () => {
    // Геометрия зашита константой и зеркальна относительно центра — призрак не «рисует»
    // несуществующий рост или падение. Тест сторожит именно это: если кто-то заведёт форму
    // от данных или просто перекосит точки, карточка начнёт врать о том, чего не измеряли.
    const html = renderToStaticMarkup(<EmptyGhostShape kind="line" />);
    const path = /\sd="([^"]+)"/.exec(html)?.[1] ?? '';
    const ys = path.split(/[ML]/).filter(Boolean).map((pair) => Number(pair.trim().split(' ')[1]));
    expect(ys).toHaveLength(7);
    expect(ys).toEqual([...ys].reverse());
  });
});
