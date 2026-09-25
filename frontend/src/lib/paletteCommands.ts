/**
 * ⌘K-ПАЛИТРА: чистое построение команд (без React, без навигации) — компонент
 * (components/CommandPalette.tsx) только подставляет иконки и `run`.
 *
 * Разделы и источники строятся из ЕДИНОГО реестра сетей (lib/networks): его `nav` уже знает
 * маршруты/подписи/иконки каждой сети, а `hasChannel(channel)` — какие сети канал вообще
 * выставляет источником. До этого палитра держала свой список маршрутов (МойСклад и Метрика в ⌘K
 * не попадали вовсе) и фильтровала источники по одному `ig_connected`, из-за чего у любого канала
 * появлялись строки почти всех сетей — вплоть до «Метрики» у телеграм-канала (внешний аудит).
 */
import { NETWORKS, type ChannelSourceLike, type NavLinkDef } from '@/lib/networks';
import { ANALYTICS_TABS } from '@/lib/analyticsTabs';
import { CAMPAIGNS_LIST } from '@/components/campaigns/routes';
import type { IconName } from '@/components/nav-icons';

/** Запись реестра сетей — литеральный тип (а не расширенный `NetworkDef`), чтобы `key` оставался
    союзом 'tg' | 'ig' | … и годился для networkStore.setActiveNetwork. */
export type PaletteNetwork = (typeof NETWORKS)[number];

/** Минимум полей канала, нужный палитре: предикаты сетей + подпись строки. Структурный тип —
    объект канала из API его удовлетворяет. */
export interface PaletteChannel extends ChannelSourceLike {
  id: number;
  username?: string | null;
  title?: string | null;
}

export interface RouteCommandSpec {
  id: string;
  path: string;
  label: string;
  icon: IconName;
  search: string;
}

export interface SourceCommandSpec {
  id: string;
  channelId: number;
  channelName: string;
  network: PaletteNetwork;
  label: string;
  search: string;
}

export interface MetricCommandSpec {
  id: string;
  key: string;
  label: string;
  search: string;
}

/** Латинские/разговорные синонимы для fuzzy-поиска: реестр знает только каноничную русскую
    подпись раздела, а палитра исторически находила разделы и по «overview/analytics/posts».
    Ключ — подпись из `nav`, поэтому синоним работает сразу во всех сетях с этим разделом. */
const SECTION_SEARCH_SYNONYMS: Record<string, string> = {
  Обзор: 'главная overview',
  Аналитика: 'графики analytics',
  Контент: 'посты публикации posts content',
  Упоминания: 'mentions',
  Аудитория: 'audience',
  Клиенты: 'покупатели clients',
  Каналы: 'источники продаж channels',
  // Подразделы (см. buildTgSectionCommands): те же ключи-подписи, что у вкладок и второго
  // представления «Контента».
  Кампании: 'кампания campaign campaigns промо',
  Динамика: 'dynamics рост',
  Форматы: 'формат типы форматов formats content',
  Сравнение: 'сравнить compare comparison',
};

/** То же для названий сетей (реестр хранит одно каноничное имя). */
const NETWORK_SEARCH_SYNONYMS: Record<string, string> = {
  tg: 'telegram телеграм',
  ig: 'instagram инстаграм',
  ms: 'мойсклад склад продажи',
  ym: 'яндекс метрика metrika',
};

/**
 * IG-метрики числового drill-набора (`/metrics/ig-*` → IgMetricPage). Список остаётся ручным
 * СОЗНАТЕЛЬНО: их подписи живут внутри самого IgMetricPage (DAILY_DEFS), а он — ленивый чанк;
 * импорт ради подписей затащил бы страницу метрик в entry-бандл и сломал bundle-гейт. Реестры
 * `*MetricKeys` тут не помогают: они покрывают ДРУГОЕ семейство (ig-* карточные ключи) и подписей
 * не содержат. Новая IG-метрика — строка сюда.
 */
const IG_METRICS: ReadonlyArray<readonly [string, string]> = [
  ['ig-reach', 'Охват (IG)'],
  ['ig-follows', 'Подписки (IG)'],
  ['ig-views', 'Просмотры (IG)'],
  ['ig-interactions', 'Взаимодействия (IG)'],
  ['ig-likes', 'Лайки (IG)'],
  ['ig-saves', 'Сохранения (IG)'],
  ['ig-er', 'Вовлечённость ER (IG)'],
];

/** Отображаемое имя канала — как в сайдбаре: @username, иначе заголовок, иначе id. */
export function channelDisplayName(channel: PaletteChannel): string {
  return String(channel.username || channel.title || channel.id);
}

/**
 * Сети, которые эта мастерская реально выставляет источником — реестровый предикат `hasChannel`
 * (тот же, что у DashboardLayout и SourceSwitcher). Пустой список каналов = данные ещё не доехали:
 * показываем все сети, иначе палитра на первом кадре пустеет.
 */
export function availableNetworks(channels: PaletteChannel[]): PaletteNetwork[] {
  if (channels.length === 0) return [...NETWORKS];
  return NETWORKS.filter((net) => channels.some((channel) => net.hasChannel(channel)));
}

/** Сеть подключена к мастерской? */
export function hasNetwork(channels: PaletteChannel[], key: string): boolean {
  return availableNetworks(channels).some((net) => net.key === key);
}

/**
 * Команды «Разделы» для сетевых маршрутов — прямо из `NETWORKS[].nav`.
 *
 */
export function buildNetworkRouteCommands(
  channels: PaletteChannel[],
): RouteCommandSpec[] {
  return availableNetworks(channels).flatMap((net) =>
    (net.nav as readonly NavLinkDef[]).map((link) => ({
      id: `route:${link.to}`,
      path: link.to,
      // Сеть по умолчанию (единственная беспрефиксная запись реестра) не подписывается —
      // «Обзор», а не «Telegram · Обзор»; у остальных префикс сети остаётся, как было у IG.
      label: 'prefix' in net ? `${net.name} · ${link.label}` : link.label,
      icon: link.icon,
      search: [
        'перейти',
        link.label,
        net.name,
        SECTION_SEARCH_SYNONYMS[link.label] ?? '',
        NETWORK_SEARCH_SYNONYMS[net.key] ?? '',
      ]
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase(),
    })),
  );
}

/**
 * Подразделы Telegram, до которых из палитры иначе не добраться: «Кампании» — целая вертикаль,
 * живущая вторым представлением раздела «Контент» (`?view=campaigns`), в сайдбаре её нет вовсе;
 * и четыре вкладки /analytics (`?tab=`). Гейт — тот же реестровый `hasNetwork('tg')`, что и у
 * самих разделов. Instagram своих подразделов не получает: его разделы уже плоские (отдельные
 * маршруты), а IG-кампании открываются с той же страницы кампаний — второй строки не плодим.
 *
 * Подписи вкладок берутся из `ANALYTICS_TABS` — второго списка этих строк в приложении нет.
 * id остаются стабильными `route:<путь>`: на них завязана MRU-история (`pulse_palette_recents`).
 */
export function buildTgSectionCommands(channels: PaletteChannel[]): RouteCommandSpec[] {
  if (!hasNetwork(channels, 'tg')) return [];
  const entries: ReadonlyArray<{ path: string; label: string; section: string; icon: IconName }> = [
    { path: CAMPAIGNS_LIST, label: 'Кампании', section: 'Кампании', icon: 'campaigns' },
    ...ANALYTICS_TABS.map((tab) => ({
      path: `/analytics?tab=${tab.key}`,
      label: `Аналитика · ${tab.label}`,
      section: tab.label,
      icon: 'analytics' as IconName,
    })),
  ];
  return entries.map(({ path, label, section, icon }) => ({
    id: `route:${path}`,
    path,
    label,
    icon,
    search: [
      'перейти',
      label.replace(' · ', ' '),
      SECTION_SEARCH_SYNONYMS[section] ?? '',
      NETWORK_SEARCH_SYNONYMS.tg,
    ]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase(),
  }));
}

/**
 * Команды «Источники» = (канал × сеть). Сети канала берутся ТОЛЬКО через реестровый `hasChannel`,
 * поэтому у ТГ-канала нет строки Instagram/МойСклад/Метрики, а у ms-канала — телеграма.
 * Один канал = выбор не нужен: группа появляется от двух каналов (историческое поведение).
 */
export function buildSourceCommands(channels: PaletteChannel[]): SourceCommandSpec[] {
  if (channels.length < 2) return [];
  return channels.flatMap((channel) => {
    const name = channelDisplayName(channel);
    return NETWORKS.filter((net) => net.hasChannel(channel)).map((net) => ({
      id: `source:${net.key}:${channel.id}`,
      channelId: channel.id,
      channelName: name,
      network: net,
      label: `@${name} · ${net.name}`,
      search: `перейти сменить источник канал ${net.name} ${name}`.toLowerCase(),
    }));
  });
}

/** IG-метрики — только когда Instagram вообще подключён (как и IG-разделы). */
export function buildIgMetricCommands(channels: PaletteChannel[]): MetricCommandSpec[] {
  if (!hasNetwork(channels, 'ig')) return [];
  return IG_METRICS.map(([key, label]) => ({
    id: `metric:${key}`,
    key,
    label,
    search: `метрика instagram ${label}`.toLowerCase(),
  }));
}
