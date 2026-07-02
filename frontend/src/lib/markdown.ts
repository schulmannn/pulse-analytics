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

// Order matters: links, then ** / __ (bold) before * (italic), then `code`. A single `_` is
// intentionally NOT italic — it collides with snake_case identifiers and @handles in real
// captions. Paired `__…__` (Telegram MarkdownV2 underline / common emphasis) IS rendered as
// bold: the reviewer wants it shown as emphasis, not as literal underscores.
const TOKEN =
  /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`|\*([^*\n]+)\*/g;

// Captions frequently arrive with broken/unclosed markdown (e.g. a leading "**Сегодня" with no
// closing pair). Those never tokenize, so we strip orphan `**` from the literal text that's left
// over rather than render the raw asterisks. `__` orphans are left alone — bare double-underscores
// occur in identifiers (`__init__`, `a__b`) far more than as broken markup.
function stripOrphanMarks(text: string): string {
  return text.replace(/\*\*/g, '');
}

// Archive captions are 500-char SNIPPETS; older rows were cut over RAW markdown, so the
// tail can hold a half-token — "[label](https://…" with no closing paren never tokenizes
// and used to render literally (D6.2). Salvage the label, drop the marker debris. Only the
// very END of the string is touched: truncation is by definition a tail artefact.
function repairTruncatedTail(text: string): string {
  return text
    .replace(/\[([^\]\n]*)\]\([^)\s]*$/, '$1') // [label](url-cut → label
    .replace(/\[([^\]\n]*)$/, '$1'); // [label-cut → label
  // NOT stripping trailing */` dust: a trailing marker is usually the legit CLOSER of a
  // token («*i*», «`код`») — orphan ** pairs are already handled by stripOrphanMarks.
}

function pushText(nodes: MdNode[], value: string): void {
  const cleaned = stripOrphanMarks(value);
  if (cleaned) nodes.push({ type: 'text', value: cleaned });
}

/** Parse a single string of inline markdown into a flat list of nodes (no nesting). */
export function parseInlineMarkdown(rawInput: string): MdNode[] {
  if (!rawInput) return [];
  // Defensive cap: real captions are short (Telegram ≤4096, Instagram ≤2200). Bounding the input
  // keeps the linear-with-quadratic-tail tokenizer cheap even if the data path ever changes.
  const input = repairTruncatedTail(rawInput.length > 8000 ? rawInput.slice(0, 8000) : rawInput);
  const nodes: MdNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(input)) !== null) {
    if (match.index > last) pushText(nodes, input.slice(last, match.index));
    if (match[1] !== undefined) {
      const href = match[2];
      if (SAFE_URL.test(href)) nodes.push({ type: 'link', value: match[1], href });
      else pushText(nodes, match[0]); // unsafe scheme → keep literal
    } else if (match[3] !== undefined) {
      nodes.push({ type: 'bold', value: match[3] }); // **bold**
    } else if (match[4] !== undefined) {
      nodes.push({ type: 'bold', value: match[4] }); // __bold__ (rendered as emphasis)
    } else if (match[5] !== undefined) {
      nodes.push({ type: 'code', value: match[5] });
    } else if (match[6] !== undefined) {
      nodes.push({ type: 'italic', value: match[6] });
    }
    last = TOKEN.lastIndex;
  }
  if (last < input.length) pushText(nodes, input.slice(last));
  return nodes;
}

/**
 * Flatten inline markdown to plain text — drops the markers but keeps link/bold/italic/code
 * content. For places that show a caption *snippet* (e.g. the auto-summary) where rendering
 * React nodes is overkill but raw `**…**` must never leak. Line breaks become a « · »
 * separator — collapsing them to a bare space glued paragraphs into nonsense
 * («…мастерской Именно…», D6.2); other whitespace is collapsed.
 */
export function markdownToPlainText(text: string): string {
  return parseInlineMarkdown(text)
    .map((node) => node.value)
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n+\s*/g, ' · ')
    .trim();
}
