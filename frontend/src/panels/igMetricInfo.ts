/**
 * Тексты ⓘ метрик Instagram из каталога виджетов. Чистые данные без зависимостей: синхронно их
 * читает lib/widgetMetrics.ts, лениво — igMetricDetails через loadMetricDetails('ig').
 * Тексты страниц /metrics/ig-* пока живут в самой IgMetricPage.
 */
import type { MetricInfo } from '@/lib/metricDetails';

export const IG_METRIC_INFO: Readonly<Record<string, MetricInfo>> = {
  'ig.reach': {
    label: 'Охват',
    formula: 'Сумма дневных охватов за окно; дневной охват — уникальные аккаунты за сутки.',
    included:
      'Сумма дневных уникальных ≠ уникальные за период: зритель, вернувшийся в разные дни, посчитан несколько раз.',
    sourceNote: 'Instagram Graph (insights).',
  },
  'ig.followers': {
    label: 'Подписчики',
    formula: 'Текущее число подписчиков аккаунта.',
    included:
      'История уровня реконструируется по движению follows − unfollows: Instagram не отдаёт дневной ряд самого числа подписчиков.',
    sourceNote: 'Профиль Instagram Graph (текущее число) + дневной архив для линии.',
  },
  'ig.netFollowers': {
    label: 'Прирост подписчиков',
    formula: 'Чистый прирост подписчиков за окно: подписки минус отписки.',
    included:
      'Instagram отдаёт подписки и отписки только агрегатом за окно, дневного ряда нет — на графике величина приходит одной ступенью в конце периода. Честное число — в шапке.',
  },
  'ig.erv': {
    label: 'Вовлечённость (ER)',
    formula: 'ER = взаимодействия ÷ сумма дневных охватов × 100%.',
    included:
      'Вовлечённость на охват устойчивее к размеру аудитории. Знаменатель — сумма дневных охватов, а не дедуплицированный охват периода, поэтому значение ниже ER из раздела Instagram.',
  },
  'ig.interactions': {
    label: 'Взаимодействия',
    formula: 'Лайки + комментарии + сохранения + репосты за период.',
    included:
      'Instagram считает взаимодействия агрегатом за окно, дневного ряда нет — на графике весь период приходит одной точкой в конце. Честное число — в шапке.',
  },
  'ig.formats': {
    label: 'Вовлечённость по форматам',
    formula: 'Сумма взаимодействий по типу публикации — Лента / Reels / Stories / Карусель.',
    included:
      'Считаются взаимодействия, а не число публикаций: формат с одним вирусным постом обгонит формат с десятью тихими.',
  },
  'ig.age': {
    label: 'Возраст',
    formula: 'Распределение подписчиков по возрастным группам.',
    sourceNote: 'Instagram Graph (demographics).',
  },
  'ig.gender': {
    label: 'Пол',
    formula: 'Распределение подписчиков по полу.',
    sourceNote: 'Instagram Graph (demographics).',
  },
  'ig.countries': {
    label: 'Страны',
    formula: 'Топ стран аудитории.',
    sourceNote: 'Instagram Graph (demographics).',
  },
  'ig.cities': {
    label: 'Города',
    formula: 'Топ городов аудитории.',
    sourceNote: 'Instagram Graph (demographics).',
  },
  'ig.hours': {
    label: 'Лучшее время',
    formula:
      'Относительная активность часа: среднее число подписчиков онлайн в этот час по каждому дню недели, затем семь значений складываются.',
    included: 'Часы сравнимы между собой, но само значение — не число людей онлайн.',
    sourceNote: 'Instagram Graph (online_followers).',
  },
};
