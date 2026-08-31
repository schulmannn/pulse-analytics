import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const connectSource = readFileSync(fileURLToPath(new URL('./Connect.tsx', import.meta.url)), 'utf8');

function openingTags(tagName: 'button' | 'input'): string[] {
  const lines = connectSource.split('\n');
  const tags: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes(`<${tagName}`)) continue;
    const block: string[] = [];
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      block.push(lines[cursor]);
      if (lines[cursor].trimEnd().endsWith('>')) break;
    }
    tags.push(block.join('\n'));
  }
  return tags;
}

describe('Connect phone touch-target source contract', () => {
  it('marks and sizes every plain button rather than relying on root-only E2E coverage', () => {
    const buttons = openingTags('button');

    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button, button).toContain('data-mobile-touch-target=""');
      expect(button, button).toMatch(/\b(?:min-h-11|size-12)\b/);
    }
  });

  it('keeps text inputs 44px tall and gives native choice rows a 44px label target', () => {
    const inputs = openingTags('input');
    const textInputs = inputs.filter(
      (input) => !input.includes('type="checkbox"') && !input.includes('type="radio"'),
    );

    // Токен МойСклада, OAuth-токен Метрики, счётчик Метрики, имя источника СДЭК и API-ключ
    // Rusender. Число здесь намеренно жёсткое: новое текстовое поле обязано осознанно пройти
    // этот контракт, а не просочиться мимо него.
    expect(textInputs).toHaveLength(5);
    for (const input of textInputs) {
      expect(input, input).toContain('data-mobile-touch-target=""');
      expect(input, input).toMatch(/\b(?:h-11|min-h-11)\b/);
    }
    expect(connectSource).toMatch(
      /<label data-mobile-touch-target="" className=\{cn\('flex min-h-11[\s\S]*?<input\s+type="checkbox"/,
    );
    expect(connectSource).toMatch(
      /<label[\s\S]*?data-mobile-touch-target=""[\s\S]*?className="absolute block size-12[\s\S]*?<input\s+type="radio"/,
    );
  });
});
