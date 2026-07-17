import type { ReactNode } from 'react';
import { Icon } from '@/components/nav-icons';
import { PillSelect } from '@/components/PillSelect';

/** Lucide-style pencil (inline — the nav icon set stays lean). */
export function PencilGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

interface BlockFrameProps {
  idx: number;
  count: number;
  onMove: (idx: number, dir: -1 | 1) => void;
  onRemove: (idx: number) => void;
  children: ReactNode;
}

/**
 * Always-on inline editing wrapper: a hover toolbar (↑ / ↓ / ×) floats above the block's
 * top-right corner, revealed on block hover or keyboard focus. It's print-hidden, so the
 * printed document is just the block content.
 */
export function BlockFrame({ idx, count, onMove, onRemove, children }: BlockFrameProps) {
  return (
    <div className="group/block relative">
      <div className="absolute bottom-full right-0 z-20 mb-1 flex items-center gap-0.5 rounded border border-border bg-card p-0.5 opacity-0 transition-opacity group-hover/block:opacity-100 focus-within:opacity-100 print:hidden">
        <BlockCtl onClick={() => onMove(idx, -1)} disabled={idx <= 0} label="Переместить выше">
          <Icon name="chevron" className="h-3.5 w-3.5 rotate-180" />
        </BlockCtl>
        <BlockCtl onClick={() => onMove(idx, 1)} disabled={idx >= count - 1} label="Переместить ниже">
          <Icon name="chevron" className="h-3.5 w-3.5" />
        </BlockCtl>
        <BlockCtl onClick={() => onRemove(idx)} label="Убрать блок">
          <span aria-hidden="true" className="text-sm leading-none">
            ×
          </span>
        </BlockCtl>
      </div>
      {children}
    </div>
  );
}

/** Quiet 24px ghost control for the block frame (hover fill only, no border). */
function BlockCtl({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/** Print-hidden row of a block's own inline config controls (metric / viz / source). */
export function BlockControls({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 print:hidden">{children}</div>;
}

/** Hairline control backed by PillSelect — accessible + cheap, same external API. */
export function MiniSelect({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  ariaLabel: string;
}) {
  return <PillSelect value={value} options={options} onValueChange={onChange} ariaLabel={ariaLabel} />;
}

/** Two/three-way segmented toggle (line ↔ bar). */
export function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-full border border-border">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`border-r border-border px-2 py-1 text-xs font-medium transition-colors last:border-r-0 ${
              active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
