// Minimal, safe inline-markdown parser for post captions. Telegram/IG captions arrive with
// literal markdown (**bold**, [label](url), `code`) that would otherwise render raw. We parse a
// small, well-known subset into tokens; the renderer turns them into React elements (never
// innerHTML), so there is no XSS surface and CSP `script-src 'self'` is unaffected.

export type MdNode =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; value: string; href: string };

// Only http(s) links are followed; anything else (javascript:, data:, …) renders as literal text.
const SAFE_URL = /^https?:\/\//i;

// Order matters: links, then ** (bold) before * (italic), then `code`. `_` is intentionally NOT
// treated as italic — it collides with snake_case identifiers and @handles in real captions.
const TOKEN = /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`|\*([^*\n]+)\*/g;

/** Parse a single string of inline markdown into a flat list of nodes (no nesting). */
export function parseInlineMarkdown(rawInput: string): MdNode[] {
  if (!rawInput) return [];
  // Defensive cap: real captions are short (Telegram ≤4096, Instagram ≤2200). Bounding the input
  // keeps the linear-with-quadratic-tail tokenizer cheap even if the data path ever changes.
  const input = rawInput.length > 8000 ? rawInput.slice(0, 8000) : rawInput;
  const nodes: MdNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(input)) !== null) {
    if (match.index > last) nodes.push({ type: 'text', value: input.slice(last, match.index) });
    if (match[1] !== undefined) {
      const href = match[2];
      if (SAFE_URL.test(href)) nodes.push({ type: 'link', value: match[1], href });
      else nodes.push({ type: 'text', value: match[0] }); // unsafe scheme → keep literal
    } else if (match[3] !== undefined) {
      nodes.push({ type: 'bold', value: match[3] });
    } else if (match[4] !== undefined) {
      nodes.push({ type: 'code', value: match[4] });
    } else if (match[5] !== undefined) {
      nodes.push({ type: 'italic', value: match[5] });
    }
    last = TOKEN.lastIndex;
  }
  if (last < input.length) nodes.push({ type: 'text', value: input.slice(last) });
  return nodes;
}
