import { describe, expect, it } from 'vitest';
import { parseAiBlocks } from './aiMessage';

describe('parseAiBlocks', () => {
  it('пустой/пробельный ввод → нет блоков', () => {
    expect(parseAiBlocks('')).toEqual([]);
    expect(parseAiBlocks('  \n\n  ')).toEqual([]);
  });

  it('абзацы разделяются пустой строкой, одиночные переносы сохраняются в тексте', () => {
    const blocks = parseAiBlocks('Первый абзац.\nвторая строка.\n\nВторой абзац.');
    expect(blocks).toEqual([
      { kind: 'p', text: 'Первый абзац.\nвторая строка.' },
      { kind: 'p', text: 'Второй абзац.' },
    ]);
  });

  it('маркированные и нумерованные списки собираются в items без маркеров', () => {
    const blocks = parseAiBlocks('- первый\n- второй\n\n1. раз\n2) два');
    expect(blocks).toEqual([
      { kind: 'list', items: ['первый', 'второй'] },
      { kind: 'list', items: ['раз', 'два'] },
    ]);
  });

  it('вводная строка + список без пустой строки → отдельные блоки в исходном порядке', () => {
    const blocks = parseAiBlocks('Вот итоги недели:\n- просмотры выросли\n- ER стабилен');
    expect(blocks).toEqual([
      { kind: 'p', text: 'Вот итоги недели:' },
      { kind: 'list', items: ['просмотры выросли', 'ER стабилен'] },
    ]);
  });

  it('заголовки #–#### становятся heading-блоками', () => {
    const blocks = parseAiBlocks('## Динамика\nТекст после заголовка.');
    expect(blocks).toEqual([
      { kind: 'heading', text: 'Динамика' },
      { kind: 'p', text: 'Текст после заголовка.' },
    ]);
  });
});
