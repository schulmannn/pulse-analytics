import { DataHealth } from '@/components/DataHealth';
import { SettingsGroup, SettingsIcon } from '@/components/settings/primitives';

/** «Данные» — the data-health ledger + a row-link into the channels section. */
export function DataSection({ onOpenChannels }: { onOpenChannels: () => void }) {
  return (
    <SettingsGroup title="Состояние данных">
      <div className="px-4 py-3.5">
        <DataHealth defaultOpen />
      </div>
      <button
        type="button"
        onClick={onOpenChannels}
        className="flex w-full items-center justify-between gap-6 px-4 py-3.5 text-left transition-colors hover:bg-hover-row"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">Настроить сбор</span>
          <span className="mt-0.5 block max-w-[46ch] text-xs leading-relaxed text-ink3">
            Каналы, коллекторы и API-ключи — в разделе «Каналы».
          </span>
        </span>
        <SettingsIcon name="arrow" className="h-4 w-4 shrink-0 text-ink3" />
      </button>
    </SettingsGroup>
  );
}
