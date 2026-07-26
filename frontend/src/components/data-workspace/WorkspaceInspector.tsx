import type { HTMLAttributes, ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** Body wrapper props: standard attributes plus any consumer-specific `data-*` hooks/testids. */
export type WorkspaceInspectorBodyProps = HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>;

/**
 * Reusable adjacent inspector shell. `<aside>` carries the complementary landmark natively; the
 * shell owns the padding chrome and the title + close row, while the consumer supplies the
 * read-first body and an optional action footer. Presentation only — it never fetches or duplicates
 * domain logic. Pass `bodyProps` to attach consumer-specific data hooks/testids to the inner
 * content wrapper.
 */
export function WorkspaceInspector({
  label,
  title,
  onClose,
  closeLabel = 'Закрыть',
  children,
  footer,
  bodyProps,
}: {
  /** Accessible label for the complementary landmark. */
  label: string;
  title: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
  bodyProps?: WorkspaceInspectorBodyProps;
}) {
  return (
    <aside aria-label={label} className="w-full shrink-0 overflow-auto p-4">
      <div
        className="space-y-4"
        data-workspace-inspector
        data-workspace-inspector-open=""
        {...bodyProps}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">{title}</span>
          <Button type="button" variant="ghost" size="xs" onClick={onClose}>
            {closeLabel}
          </Button>
        </div>
        {children}
        {footer && <div className="flex flex-wrap gap-2">{footer}</div>}
      </div>
    </aside>
  );
}

/**
 * Read-only «термин → значение» block of an inspector: a titled, single-column `<dl>` whose label
 * column is sized to the widest term. `break-words` (overflow-wrap, NOT anywhere) is deliberate —
 * it lets a long term wrap without collapsing the value track to one character per line.
 */
export function WorkspaceMetadataList({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="mb-3 text-base leading-6 text-foreground">{title}</div>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">{children}</dl>
    </div>
  );
}

/** One `<dt>`/`<dd>` pair of a {@link WorkspaceMetadataList}; both are direct grid children. */
export function WorkspaceMetadataItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex min-h-6 items-center gap-2 break-words text-sm font-medium text-muted-foreground">
        {label}
      </dt>
      <dd className="min-h-6 break-words text-sm text-foreground">{children}</dd>
    </>
  );
}
