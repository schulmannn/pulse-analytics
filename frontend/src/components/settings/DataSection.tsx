import { DataHealth } from '@/components/DataHealth';
import { SettingsGroup, SettingsIcon } from '@/components/settings/primitives';

/** «Данные» — the data-health ledger + a row-link into the channels section. */
export function DataSection({ onOpenChannels }: { onOpenChannels: () => void }) {
  return (
    <SettingsGroup>
      <div className="py-4">
        <DataHealth defaultOpen />
      </div>
      <button
        type="button"
        onClick={onOpenChannels}
        className="group flex w-full items-center justify-between gap-6 py-4 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground transition-colors group-hover:text-primary">
            Настроить сбор
          </span>
          <span className="mt-0.5 block max-w-[56ch] text-xs leading-relaxed text-ink3">
            Каналы, коллекторы и API-ключи — в разделе «Каналы».
          </span>
        </span>
        <SettingsIcon
          name="arrow"
          className="h-4 w-4 shrink-0 text-ink3 transition-transform group-hover:translate-x-0.5"
        />
      </button>
    </SettingsGroup>
  );
}
