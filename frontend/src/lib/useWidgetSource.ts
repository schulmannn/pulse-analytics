// Одно место, где WidgetConfig превращается в канал-источник своей СЕТИ. Раньше эта резолюция
// жила только внутри ConfigWidget, поэтому карточка Главной читала правильный канал, а её
// полноэкранный эксплорер (`/widgets/:id`, WidgetExplorer) — глобальный свитчер. Если свитчер
// стоял на канале другой сети (МойСклад, Яндекс.Метрика), TG/IG-виджет в эксплорере резолвился
// против чужого канала: `/api/tg/full` для ym-канала честно отдаёт `{channel:{}, posts:[]}`, серия
// получалась из одних нулей, и график выглядел как «не отрисовался вообще».

import { useMemo } from 'react';
import { useChannels } from '@/api/queries';
import { getRememberedChannel } from '@/lib/channel';
import { resolveHomeSourceChannel } from '@/lib/channelSource';
import { getMetric } from '@/lib/widgetMetrics';
import type { SourceNetwork } from '@/lib/homeSourceContext';
import type { WidgetConfig } from '@/lib/widgetConfig';

/** Сеть, к которой принадлежит метрика виджета (legacy-композиты и неизвестные id — Telegram). */
export function widgetSourceNetwork(metricId: string): 'tg' | 'ig' | 'ms' | 'ym' {
  const source = getMetric(metricId)?.source;
  return source === 'ig' ? 'ig' : source === 'ms' ? 'ms' : source === 'ym' ? 'ym' : 'tg';
}

/**
 * Канал, против которого обязан резолвиться виджет.
 *
 * - явный `config.source` — всегда выигрывает (пользователь выбрал источник руками);
 * - иначе, когда виджет живёт на СВОЕЙ доске (`pinned`: карточка Главной или её эксплорер) —
 *   канал сети виджета: запомненный per-network либо первый подходящий;
 * - иначе (превью в диалоге создания, прочие поверхности) — `null`: следовать активному каналу,
 *   поведение прежнее.
 *
 * `resolved=false` — список каналов ещё летит и авто-пин НЕВОЗМОЖНО отличить от «каналов нет»:
 * на холодном deep-link рендер без гейта ушёл бы нескоупленным по глобальному каналу (возможно,
 * другой сети) и перещёлкнулся после ответа — транзиентный кросс-сетевой fetch, который инвариант
 * «выбранный источник не зависит от порядка ответа API» запрещает.
 */
export function useWidgetSourceChannel(
  config: WidgetConfig,
  { pinned }: { pinned: boolean },
): { network: SourceNetwork; channelId: number | null; resolved: boolean } {
  const network = widgetSourceNetwork(config.metricId);
  const channels = useChannels().data?.channels;
  const resolved = config.source != null || !pinned || channels !== undefined;
  const channelId = useMemo(() => {
    if (config.source != null) return config.source;
    if (!pinned) return null;
    return resolveHomeSourceChannel(channels ?? [], network, getRememberedChannel(network));
  }, [config.source, pinned, channels, network]);
  return { network, channelId, resolved };
}
