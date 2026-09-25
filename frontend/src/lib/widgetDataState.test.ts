import { describe, expect, it } from 'vitest';
import { widgetDataStateOf } from '@/lib/widgetDataState';

/**
 * Ошибка ≠ пустота. Раньше упавший запрос доходил до карточки неотличимо от честного «за этот
 * период данных нет»: `isPending` уходил в false, данные оставались undefined, резолвер отдавал
 * `empty`, и виджет печатал «Нет данных за период» — то есть выдавал сбой сети за достоверный
 * ответ, ещё и без единого способа повторить.
 */
describe('widgetDataStateOf', () => {
  it('reports a failed query as an error, not as an empty period', () => {
    const s = widgetDataStateOf({ channelId: 1, pending: [false], errored: [true], fetching: [false] });
    expect(s.isError).toBe(true);
    expect(s.isLoading).toBe(false);
  });

  it('keeps loading and error mutually exclusive — a pending retry is not a failure', () => {
    const s = widgetDataStateOf({ channelId: 1, pending: [true], errored: [true], fetching: [true] });
    expect(s.isLoading).toBe(true);
    expect(s.isError).toBe(false); // иначе карточка одновременно грузилась бы и показывала сбой
  });

  it('treats one failed source among several as a failure of the card', () => {
    const s = widgetDataStateOf({ channelId: 1, pending: [false, false], errored: [false, true], fetching: [false, false] });
    expect(s.isError).toBe(true);
  });

  // Без канала запросы отключены и вечно «pending» — это честная пустота, а не загрузка и не сбой.
  it('is neither loading nor failing when no channel is selected', () => {
    const s = widgetDataStateOf({ channelId: null, pending: [true], errored: [false], fetching: [false] });
    expect(s.isLoading).toBe(false);
    expect(s.isError).toBe(false);
  });

  it('surfaces an in-flight refetch so the retry pill can disable itself', () => {
    const s = widgetDataStateOf({ channelId: 1, pending: [false], errored: [true], fetching: [true] });
    expect(s.isRetrying).toBe(true);
  });

  it('is a plain success when everything resolved', () => {
    const s = widgetDataStateOf({ channelId: 1, pending: [false], errored: [false], fetching: [false] });
    expect(s).toEqual({ isLoading: false, isError: false, isRetrying: false });
  });
});
