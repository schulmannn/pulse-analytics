/**
 * Блочная структура ответа AI-ассистента. Модель отвечает markdown'ом умеренной сложности
 * (абзацы, списки, заголовки); inline-разметку (**жирный**, `код`, ссылки) рендерит существующий
 * безопасный RichText/parseInlineMarkdown. Здесь — только разбиение на блоки: чистая функция,
 * тестируется без React (aiMessage.test.ts).
 */

export type AiBlock =
  | { kind: 'p'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] };

const LIST_ITEM = /^\s*(?:[-•*]|\d+[.)])\s+/;
const HEADING = /^#{1,4}\s+/;

export function parseAiBlocks(raw: string): AiBlock[] {
  const blocks: AiBlock[] = [];
  for (const chunk of String(raw ?? '').split(/\n{2,}/)) {
    const lines = chunk.split('\n').filter((l) => l.trim().length > 0);
    if (!lines.length) continue;

    // Внутри одного «абзаца» могут соседствовать вводная строка и список — разносим по типам,
    // сохраняя порядок (модель часто пишет «Вот итоги:\n- a\n- b» без пустой строки).
    let para: string[] = [];
    let list: string[] = [];
    const flushPara = () => {
      if (para.length) blocks.push({ kind: 'p', text: para.join('\n') });
      para = [];
    };
    const flushList = () => {
      if (list.length) blocks.push({ kind: 'list', items: list });
      list = [];
    };
    for (const line of lines) {
      if (LIST_ITEM.test(line)) {
        flushPara();
        list.push(line.replace(LIST_ITEM, '').trim());
      } else if (HEADING.test(line.trim())) {
        flushPara();
        flushList();
        blocks.push({ kind: 'heading', text: line.trim().replace(HEADING, '') });
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
  }
  return blocks;
}
