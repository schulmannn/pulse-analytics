import { describe, expect, it } from 'vitest';
import {
  composeAiQuestion,
  emptyAiAskContext,
  setAiPeriod,
  toggleAiSource,
  type AiAskSource,
} from './aiAsk';

const SOURCES: AiAskSource[] = [
  { id: 3, username: 'notem', title: 'Канал' },
  { id: 5, username: null, title: 'Instagram-аккаунт' },
];

describe('composeAiQuestion', () => {
  it('без контекста — просто тримленный вопрос', () => {
    expect(composeAiQuestion('  Как дела?  ', emptyAiAskContext, SOURCES)).toBe('Как дела?');
  });

  it('источник с username и без, плюс период', () => {
    const ctx = { sourceIds: [3, 5], period: 'last_month' as const };
    expect(composeAiQuestion('Сравни динамику', ctx, SOURCES)).toBe(
      'Сравни динамику\n\n(Контекст — источники: @notem (channel_id=3), Instagram-аккаунт (channel_id=5); период: прошлый месяц)',
    );
  });

  it('один источник — единственное число; неизвестный id не роняет compose', () => {
    const ctx = { sourceIds: [99], period: null };
    expect(composeAiQuestion('Вопрос', ctx, SOURCES)).toBe(
      'Вопрос\n\n(Контекст — источник: channel_id=99)',
    );
  });

  it('только период', () => {
    const ctx = { sourceIds: [], period: 'this_week' as const };
    expect(composeAiQuestion('Что нового?', ctx, SOURCES)).toBe(
      'Что нового?\n\n(Контекст — период: эта неделя)',
    );
  });
});

describe('toggle-хелперы', () => {
  it('toggleAiSource добавляет и убирает id', () => {
    const a = toggleAiSource(emptyAiAskContext, 3);
    expect(a.sourceIds).toEqual([3]);
    expect(toggleAiSource(a, 3).sourceIds).toEqual([]);
  });

  it('setAiPeriod ставит период, повторный выбор снимает', () => {
    const a = setAiPeriod(emptyAiAskContext, 'this_month');
    expect(a.period).toBe('this_month');
    expect(setAiPeriod(a, 'this_month').period).toBeNull();
    expect(setAiPeriod(a, 'last_year').period).toBe('last_year');
  });
});
