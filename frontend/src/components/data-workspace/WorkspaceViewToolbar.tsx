import { ChevronDown } from 'lucide-react';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Row density shared by every data-workspace table. */
export type WorkspaceDensity = 'compact' | 'balanced' | 'spacious';

export const WORKSPACE_DENSITY_OPTIONS: { value: WorkspaceDensity; label: string }[] = [
  { value: 'compact', label: 'Плотно' },
  { value: 'balanced', label: 'Обычно' },
  { value: 'spacious', label: 'Свободно' },
];

export interface WorkspaceColumnOption {
  value: string;
  label: string;
}

/**
 * Reusable table view toolbar: optional-column visibility (shadcn DropdownMenu with checkbox items —
 * the same multi-select grammar the Instagram «Колонки» control uses) + row density (the shared
 * SegmentedControl). The band is a labelled `fieldset`, not a `toolbar`: each control owns its own
 * keyboard model (menu button; roving-tabindex segment track), so announcing one flat arrow-key
 * surface over both would be a lie. Presentation-only — the consumer owns which columns exist and
 * what visibility/density mean for its own rows.
 */
export function WorkspaceViewToolbar({
  label = 'Вид таблицы',
  columns,
  visibleColumns,
  onVisibleColumnsChange,
  columnsLabel = 'Колонки',
  selectAllLabel = 'Все колонки',
  density,
  onDensityChange,
}: {
  /** Accessible label for the band; also shown as the leading supporting caption. */
  label?: string;
  columns: WorkspaceColumnOption[];
  visibleColumns: string[];
  onVisibleColumnsChange: (next: string[]) => void;
  columnsLabel?: string;
  selectAllLabel?: string;
  density: WorkspaceDensity;
  onDensityChange: (next: WorkspaceDensity) => void;
}) {
  const selected = columns.filter((c) => visibleColumns.includes(c.value));
  const allSelected = selected.length === columns.length && columns.length > 0;
  // Trigger reads as the previous badge summary did: first selected column, then «+N» for the rest.
  const summary = selected.length === 0 ? columnsLabel : selected[0].label;
  const extra = selected.length > 1 ? `+${selected.length - 1}` : null;

  return (
    <fieldset className="m-0 flex min-h-7 min-w-0 flex-wrap items-center justify-between gap-2 border-0 px-3 py-2">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className="text-xs leading-5 text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs leading-5 text-muted-foreground">{columnsLabel}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="xs" aria-label={columnsLabel} className="gap-2">
                <span className="truncate">{summary}</span>
                {extra && <span className="tabular-nums text-muted-foreground">{extra}</span>}
                <ChevronDown className="size-4 opacity-60" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuCheckboxItem
                checked={allSelected}
                onCheckedChange={(checked) =>
                  onVisibleColumnsChange(checked ? columns.map((c) => c.value) : [])
                }
              >
                {selectAllLabel}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {columns.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={visibleColumns.includes(option.value)}
                  onCheckedChange={(checked) =>
                    onVisibleColumnsChange(
                      checked
                        ? columns.filter((c) => c.value === option.value || visibleColumns.includes(c.value)).map((c) => c.value)
                        : visibleColumns.filter((value) => value !== option.value),
                    )
                  }
                >
                  {option.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs leading-5 text-muted-foreground">Плотность</span>
          <SegmentedControl<WorkspaceDensity>
            ariaLabel="Плотность строк"
            value={density}
            onChange={onDensityChange}
            options={WORKSPACE_DENSITY_OPTIONS.map((d) => ({ value: d.value, content: d.label }))}
          />
        </div>
      </div>
    </fieldset>
  );
}
