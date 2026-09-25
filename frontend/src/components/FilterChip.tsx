import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * Снимаемый чип активного фильтра. Модель фильтра живёт в URL (igContentFilters / contentFilters /
 * mentionsFilters) — чип лишь показывает применённое значение и снимает ЕГО ОДНО, в отличие от
 * ссылки «Сбросить фильтры», которая снимает все разом.
 *
 * Родился локальным внутри IG-контента; поднят в общий компонент, когда тот же ряд понадобился
 * упоминаниям и публикациям — иначе на трёх рабочих поверхностях завелись бы три разных чипа.
 *
 * `variant` различает роли значений в одном ряду (поиск — default, категориальный фильтр —
 * secondary), а не «важность»: цвет тут не оценочный.
 */
export function FilterChip({
  label,
  removeLabel,
  onRemove,
  variant = 'default',
}: {
  label: string;
  removeLabel: string;
  onRemove: () => void;
  variant?: 'default' | 'secondary';
}) {
  return (
    <Badge variant={variant} className="max-w-full gap-1 pr-1">
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="-mr-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </Badge>
  );
}
