// Plain-language definitions for the dashboard metrics — surfaced via InfoTooltip so a user can
// see what a number means, how it's computed, and where it comes from without leaving the page.

export interface MetricDef {
  /** Display title (matches the card label). */
  term: string;
  /** How it's calculated, in words. */
  formula?: string;
  /** What's included / a clarifying note. */
  included?: string;
  /** Where the number comes from. */
  source?: string;
}

export const METRIC_DEFS = {
  views: {
    term: 'Просмотры за период',
    // Вариант B (#95): «Просмотры» — КАНАЛЬНЫЕ, из дневного архива; пост-сумма — только фолбэк.
    formula: 'Сумма дневных просмотров канала в выбранном окне.',
    source: 'Статистика канала (дневной архив); без архива — сумма по постам окна.',
  },
  subscribers: {
    term: 'Подписчики',
    formula: 'Текущее число подписчиков канала.',
    included: 'Δ — изменение за период (из дневного архива), а не разница «сейчас минус показанное».',
    source: 'Дневной архив channel_daily.',
  },
  avgReach: {
    term: 'Средний охват поста',
    formula: 'Просмотры за период ÷ число постов в окне.',
    source: 'Посты канала.',
  },
  reactions: {
    term: 'Реакции',
    formula: 'Сумма всех реакций-эмодзи под постами окна.',
  },
  forwards: {
    term: 'Репосты',
    formula: 'Сколько раз посты переслали (forward) за период.',
  },
  er: {
    term: 'Вовлечённость',
    formula: 'ER = (реакции + репосты + комментарии) ÷ подписчики × 100%.',
    included: 'Доля подписчиков, как-либо отреагировавших на посты периода.',
  },
  erv: {
    term: 'ERV',
    formula: 'ERV = (реакции + репосты + комментарии) ÷ просмотры × 100%.',
    included: 'Вовлечённость на просмотр (а не на подписчика) — устойчивее к охвату.',
  },
  virality: {
    term: 'Виральность',
    formula: 'Виральность = репосты ÷ просмотры × 100%.',
    included: 'Насколько активно контент разносят дальше.',
  },
  freshness: {
    term: 'Свежесть данных',
    formula: 'Дата последнего дневного снимка метрик.',
    source: 'Дневной архив channel_daily.',
  },
} satisfies Record<string, MetricDef>;

export type MetricKey = keyof typeof METRIC_DEFS;
