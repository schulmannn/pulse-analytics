import { describe, expect, it } from 'vitest';
import { markdownToPlainText, parseInlineMarkdown } from './markdown';

describe('parseInlineMarkdown', () => {
  it('returns a single text node for plain text', () => {
    expect(parseInlineMarkdown('просто текст')).toEqual([{ type: 'text', value: 'просто текст' }]);
  });

  it('parses **bold** before *italic*', () => {
    expect(parseInlineMarkdown('a **b** c')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'bold', value: 'b' },
      { type: 'text', value: ' c' },
    ]);
    expect(parseInlineMarkdown('*i*')).toEqual([{ type: 'italic', value: 'i' }]);
  });

  it('parses inline code', () => {
    expect(parseInlineMarkdown('run `npm ci`')).toEqual([
      { type: 'text', value: 'run ' },
      { type: 'code', value: 'npm ci' },
    ]);
  });

  it('parses safe http(s) links and keeps unsafe schemes literal', () => {
    expect(parseInlineMarkdown('[site](https://x.io)')).toEqual([
      { type: 'link', value: 'site', href: 'https://x.io' },
    ]);
    expect(parseInlineMarkdown('[x](javascript:alert)')).toEqual([
      { type: 'text', value: '[x](javascript:alert)' },
    ]);
    // A non-http scheme must never produce a link node.
    expect(parseInlineMarkdown('[x](javascript:alert)').some((n) => n.type === 'link')).toBe(false);
  });

  it('does not treat single underscores (snake_case / @handles) as italic', () => {
    expect(parseInlineMarkdown('media_product_type')).toEqual([
      { type: 'text', value: 'media_product_type' },
    ]);
  });

  it('renders paired __double underscore__ as bold emphasis', () => {
    expect(parseInlineMarkdown('a __b__ c')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'bold', value: 'b' },
      { type: 'text', value: ' c' },
    ]);
  });

  it('strips orphan ** from broken/unclosed markdown', () => {
    // The classic broken-caption case: a leading bold marker with no closing pair.
    expect(parseInlineMarkdown('**Сегодня празднуем')).toEqual([
      { type: 'text', value: 'Сегодня празднуем' },
    ]);
    expect(parseInlineMarkdown('a ** b')).toEqual([{ type: 'text', value: 'a  b' }]);
  });

  it('handles empty input', () => {
    expect(parseInlineMarkdown('')).toEqual([]);
  });
});

describe('markdownToPlainText', () => {
  it('strips markers, keeps content, collapses whitespace', () => {
    expect(markdownToPlainText('**Сегодня** скидка [тут](https://x.io)')).toBe('Сегодня скидка тут');
    expect(markdownToPlainText('__важно__   и  `код`')).toBe('важно и код');
    expect(markdownToPlainText('**Сегодня без закрытия')).toBe('Сегодня без закрытия');
  });
});
