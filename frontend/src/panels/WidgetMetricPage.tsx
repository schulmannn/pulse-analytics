import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { EmptyState } from '@/components/EmptyState';
import { WidgetExplorer } from '@/components/WidgetExplorer';
import { updateWidgetConfig, useWidgetConfigs } from '@/lib/widgetStore';

/** Dedicated, shareable explorer route for every config-driven Home card. */
export function WidgetMetricPage() {
  const { widgetId } = useParams<{ widgetId: string }>();
  const configs = useWidgetConfigs();
  const config = useMemo(
    () => configs.find((candidate) => candidate.id === widgetId),
    [configs, widgetId],
  );

  if (!config) {
    return (
      <EmptyState
        title="График не найден"
        reason="Виджет мог быть удалён с Главной или ещё не синхронизирован на этом устройстве."
        action={{ to: '/home', label: 'На главную' }}
      />
    );
  }

  return (
    <WidgetExplorer
      key={config.id}
      config={config}
      backTo="/home"
      onApply={(next) => updateWidgetConfig(config.id, next)}
    />
  );
}
