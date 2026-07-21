import { Toolbar } from '@astryxdesign/core/Toolbar';
import { MultiSelector } from '@astryxdesign/core/MultiSelector';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Text as AxText } from '@astryxdesign/core/Text';

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
 * Reusable table view toolbar: optional-column visibility (Astryx MultiSelector) + row density
 * (Astryx SegmentedControl). Pure Astryx children keep the toolbar's roving-tabindex intact. The
 * component is presentation-only — the consumer owns which columns exist and what visibility/density
 * mean for its own rows.
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
  /** Accessible toolbar label; also shown as the leading supporting caption. */
  label?: string;
  columns: WorkspaceColumnOption[];
  visibleColumns: string[];
  onVisibleColumnsChange: (next: string[]) => void;
  columnsLabel?: string;
  selectAllLabel?: string;
  density: WorkspaceDensity;
  onDensityChange: (next: WorkspaceDensity) => void;
}) {
  return (
    <Toolbar
      label={label}
      size="sm"
      gap={2}
      startContent={<AxText type="supporting" size="2xs">{label}</AxText>}
      endContent={
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <div className="flex items-center gap-1.5">
            <AxText type="supporting" size="2xs">{columnsLabel}</AxText>
            <MultiSelector
              label={columnsLabel}
              isLabelHidden
              placeholder={columnsLabel}
              size="sm"
              options={columns}
              value={visibleColumns}
              onChange={onVisibleColumnsChange}
              triggerDisplay="badges"
              maxBadges={1}
              hasSelectAll
              selectAllLabel={selectAllLabel}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <AxText type="supporting" size="2xs">Плотность</AxText>
            <SegmentedControl
              label="Плотность строк"
              size="sm"
              value={density}
              onChange={(v) => onDensityChange(v as WorkspaceDensity)}
            >
              {WORKSPACE_DENSITY_OPTIONS.map((d) => (
                <SegmentedControlItem key={d.value} value={d.value} label={d.label} />
              ))}
            </SegmentedControl>
          </div>
        </div>
      }
    />
  );
}
