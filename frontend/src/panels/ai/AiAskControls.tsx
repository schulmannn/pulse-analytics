import { useEffect, useRef, useState } from 'react';
import { useChannels } from '@/api/queries';
import {
  AI_PERIODS,
  aiPeriodLabel,
  aiSourceLabel,
  setAiPeriod,
  toggleAiSource,
  type AiAskContext,
  type AiPeriodKey,
} from '@/lib/aiAsk';

/**
 * STEEP-пикеры под полем вопроса: `@` — источники-контекст (multi-toggle), часы — период
 * (single-toggle). Выбор рендерится чипами в той же строке; итоговая строка контекста
 * дописывается к вопросу при отправке (lib/aiAsk.composeAiQuestion) — бэкенд не меняется.
 * Один общий компонент для hero Главной, индекса /ai и композера треда.
 */
export function AiAskControls({
  ctx,
  onCtx,
  disabled = false,
}: {
  ctx: AiAskContext;
  onCtx: (next: AiAskContext) => void;
  disabled?: boolean;
}) {
  const channels = useChannels().data?.channels ?? [];
  const [open, setOpen] = useState<'sources' | 'period' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const periodLabel = aiPeriodLabel(ctx.period);

  return (
    <div ref={rootRef} className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      <IconButton
        label="Источник-контекст"
        expanded={open === 'sources'}
        disabled={disabled}
        onClick={() => setOpen(open === 'sources' ? null : 'sources')}
      >
        <span className="text-sm font-medium leading-none" aria-hidden="true">@</span>
      </IconButton>
      <IconButton
        label="Период"
        expanded={open === 'period'}
        disabled={disabled}
        onClick={() => setOpen(open === 'period' ? null : 'period')}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-4 w-4" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.8V8l2.2 1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </IconButton>

      {ctx.sourceIds.map((id) => {
        const src = channels.find((c) => c.id === id);
        return (
          <Chip key={`s-${id}`} label={src ? aiSourceLabel(src) : `id=${id}`} onRemove={() => onCtx(toggleAiSource(ctx, id))} />
        );
      })}
      {periodLabel && <Chip label={periodLabel} onRemove={() => onCtx(setAiPeriod(ctx, null))} />}

      {open === 'sources' && (
        <div className="absolute bottom-full left-0 z-popover mb-2 w-72 rounded-xl border border-border bg-card p-1.5">
          <div className="px-2.5 py-1 text-2xs font-medium tracking-wider text-muted-foreground">Источники</div>
          {channels.length === 0 ? (
            <p className="px-2.5 py-1.5 text-sm text-muted-foreground">Нет подключённых источников.</p>
          ) : (
            channels.map((ch) => {
              const active = ctx.sourceIds.includes(ch.id);
              return (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => onCtx(toggleAiSource(ctx, ch.id))}
                  className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted ${
                    active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {ch.title || ch.username || `Источник ${ch.id}`}
                    {ch.username && <span className="ml-1.5 text-2xs text-muted-foreground">@{ch.username}</span>}
                  </span>
                  {active && (
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true">
                      <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}

      {open === 'period' && (
        <div className="absolute bottom-full left-0 z-popover mb-2 w-56 rounded-xl border border-border bg-card p-1.5">
          <div className="px-2.5 py-1 text-2xs font-medium tracking-wider text-muted-foreground">Период</div>
          {AI_PERIODS.map((p) => {
            const active = ctx.period === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  onCtx(setAiPeriod(ctx, p.key as AiPeriodKey));
                  setOpen(null);
                }}
                className={`flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted ${
                  active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {p.label}
                {active && (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true">
                    <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  expanded,
  disabled,
  onClick,
  children,
}: {
  label: string;
  expanded: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border transition-colors disabled:pointer-events-none disabled:opacity-50 ${
        expanded ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/** Круглая кнопка отправки (STEEP): стрелка ↑ в акцентном круге; busy — маленький спиннер. */
export function AiSendButton({
  disabled,
  busy = false,
  label = 'Отправить',
}: {
  disabled: boolean;
  busy?: boolean;
  label?: string;
}) {
  return (
    <button
      type="submit"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40"
    >
      {busy ? (
        <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 animate-spin" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
          <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4" aria-hidden="true">
          <path d="M8 12.5v-9M4 7l4-3.5L12 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      title="Убрать из контекста"
      className="group inline-flex max-w-44 items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-2xs font-medium text-foreground transition-colors hover:border-destructive/40"
    >
      <span className="truncate">{label}</span>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3 w-3 shrink-0 text-muted-foreground transition-colors group-hover:text-destructive" aria-hidden="true">
        <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" strokeLinecap="round" />
      </svg>
    </button>
  );
}
