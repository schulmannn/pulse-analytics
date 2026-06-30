import { parseInlineMarkdown } from '@/lib/markdown';

/**
 * Renders inline markdown in captions as React elements (never innerHTML, so CSP-safe + no XSS).
 * Links stop click propagation so a link inside a clickable post card doesn't also open the card.
 */
export function RichText({ text }: { text: string }) {
  const nodes = parseInlineMarkdown(text);
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case 'bold':
            return (
              <strong key={i} className="font-medium">
                {node.value}
              </strong>
            );
          case 'italic':
            return <em key={i}>{node.value}</em>;
          case 'code':
            return (
              <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                {node.value}
              </code>
            );
          case 'link':
            return (
              <a
                key={i}
                href={node.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                onClick={(e) => e.stopPropagation()}
                className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
              >
                {node.value}
              </a>
            );
          default:
            return <span key={i}>{node.value}</span>;
        }
      })}
    </>
  );
}
