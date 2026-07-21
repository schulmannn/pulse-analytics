import type { HTMLAttributes, ReactNode } from 'react';
import { LayoutPanel } from '@astryxdesign/core/Layout';
import { Text as AxText } from '@astryxdesign/core/Text';
import { Button as AxButton } from '@astryxdesign/core/Button';

/** Body wrapper props: standard attributes plus any consumer-specific `data-*` hooks/testids. */
export type WorkspaceInspectorBodyProps = HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>;

/**
 * Reusable adjacent inspector shell built on Astryx LayoutPanel. It owns the complementary landmark,
 * the divider/padding chrome and the title + close row; the consumer supplies the read-first body and
 * an optional action footer. Presentation only — it never fetches or duplicates domain logic. Pass
 * `bodyProps` to attach consumer-specific data hooks/testids to the inner content wrapper.
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
  /** Accessible label for the LayoutPanel landmark. */
  label: string;
  title: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
  bodyProps?: WorkspaceInspectorBodyProps;
}) {
  return (
    <LayoutPanel label={label} role="complementary" hasDivider padding={4} width="100%">
      <div
        className="space-y-4"
        data-workspace-inspector
        data-workspace-inspector-open=""
        {...bodyProps}
      >
        <div className="flex items-center justify-between gap-3">
          <AxText type="label">{title}</AxText>
          <AxButton label={closeLabel} variant="ghost" size="sm" onClick={onClose} />
        </div>
        {children}
        {footer && <div className="flex flex-wrap gap-2">{footer}</div>}
      </div>
    </LayoutPanel>
  );
}
