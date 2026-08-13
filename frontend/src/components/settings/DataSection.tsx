import { useState } from 'react';
import { DataHealth } from '@/components/DataHealth';
import { BTN_SECONDARY, SettingsGroup, SettingsIcon } from '@/components/settings/primitives';
import { fetchAccountExport } from '@/lib/accountExport';

/** «Данные» — the data-health ledger, GDPR-экспорт и row-link в раздел каналов. */
export function DataSection({ onOpenChannels }: { onOpenChannels: () => void }) {
  return (
    <SettingsGroup>
      <div className="px-4 py-4">
        <DataHealth defaultOpen />
      </div>
      <ExportRow />
      <button
        type="button"
        onClick={onOpenChannels}
        className="group flex w-full items-center justify-between gap-6 px-4 py-4 text-left"
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
          className="h-4 w-4 shrink-0 text-ink3 transition-transform group-hover-fine:translate-x-0.5"
        />
      </button>
    </SettingsGroup>
  );
}

/**
 * GDPR F5: все данные аккаунта одним JSON-файлом (профиль, настройки, отчёты, каналы с полными
 * архивами; токены и сессии не покидают сервер). Скачивание — обычный same-origin
 * cookie-auth fetch → blob-ссылка: react-query здесь не нужен, ответ не кэшируется.
 */
function ExportRow() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onExport = async () => {
    setBusy(true);
    setErr(null);
    try {
      const blob = await fetchAccountExport();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `atlavue-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Немедленный revoke обрывает скачивание в Safari/старых Firefox — отпускаем позже.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось выгрузить данные');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full items-center justify-between gap-6 px-4 py-4">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">Экспорт данных</span>
        <span className="mt-0.5 block max-w-[56ch] text-xs leading-relaxed text-ink3">
          Профиль, настройки, отчёты и архивы всех ваших каналов одним JSON-файлом.
          Токены и сессии в выгрузку не попадают.
        </span>
        {err && <span role="alert" className="mt-1 block text-xs font-medium text-destructive">{err}</span>}
      </span>
      <button type="button" onClick={onExport} disabled={busy} className={BTN_SECONDARY}>
        {busy ? 'Подготовка…' : 'Скачать JSON'}
      </button>
    </div>
  );
}
