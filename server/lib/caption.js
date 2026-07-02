// Plain-text caption snippet for the posts archive. Telegram captions arrive with inline
// markdown (**bold**, [label](url), `code`); the DB column stores a 500-char SNIPPET, and
// slicing the RAW markdown used to cut tokens in half — the dashboard then rendered a
// dangling "[label](https://…" that can never tokenize (D6.2). Strip the inline subset
// FIRST (same subset the frontend parses, frontend/src/lib/markdown.ts), then cut.

function captionSnippet(text, max = 500) {
  const plain = String(text || '')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1') // [label](url) → label
    .replace(/\*\*([^*\n]+)\*\*/g, '$1') // **bold**
    .replace(/__([^_\n]+)__/g, '$1') // __emphasis__
    .replace(/`([^`\n]+)`/g, '$1') // `code`
    .replace(/\*([^*\n]+)\*/g, '$1') // *italic*
    .replace(/\*\*/g, ''); // orphan bold markers (unclosed pairs)
  return plain.slice(0, max);
}

module.exports = { captionSnippet };
