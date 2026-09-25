import type { Page } from '@playwright/test';
import { bootDemo } from '../helpers';

/**
 * Источники для межисточниковых e2e (программа унификации источников, PR 1.7): один модуль знает,
 * как поднять источник на детерминированных данных и где его «Обзор», а спеки паритета перебирают
 * SOURCES и проверяют одно и то же свойство ОДНИМ кодом для каждого источника.
 *
 * Сейчас здесь Telegram и МойСклад. Оба поднимаются bootDemo: Telegram — из клиентских фикстур демо
 * (lib/demoFixtures), МойСклад — из детерминированного стаба /api/ms/* в helpers.bootDemo (тот же,
 * по которому написаны ms-*.spec).
 *
 * TODO(2.x–5.x): Instagram и Яндекс.Метрика — тем же bootDemo; СДЭК и Rusender — моками page.route
 * (образец — cdek-overview.spec и rusender.spec: у них нет демо-фикстур).
 */
export type SourceKey = 'tg' | 'ms';

export interface SourceFixture {
  key: SourceKey;
  /** Имя источника в интерфейсе — им подписаны тесты. */
  label: string;
  /** «Обзор» источника: лента с периодом страницы и KPI-карточками. */
  overview: string;
  /** Поднять приложение на маршруте источника (по умолчанию — на «Обзоре»). */
  boot(page: Page, route?: string): Promise<void>;
}

export const SOURCES: readonly SourceFixture[] = [
  {
    key: 'tg',
    label: 'Telegram',
    overview: '/',
    boot: (page, route = '/') => bootDemo(page, route),
  },
  {
    key: 'ms',
    label: 'МойСклад',
    overview: '/sklad',
    boot: (page, route = '/sklad') => bootDemo(page, route),
  },
];
