import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getPagePeriod,
  parsePagePeriod,
  resetPagePeriodForTest,
  setPagePeriodDays,
  setPagePeriodRange,
  subscribePagePeriod,
} from '@/lib/pagePeriodStore';

describe('общее окно ленты', () => {
  beforeEach(() => resetPagePeriodForTest());
  afterEach(() => resetPagePeriodForTest());

  it('до первого выбора окна нет — провайдер возьмёт свой дефолт', () => {
    expect(getPagePeriod()).toBeNull();
  });

  it('пресет сохраняется и снимает свой период — иначе он молча пережил бы клик по «30д»', () => {
    setPagePeriodRange({ from: 1, to: 2 }, 30);
    expect(getPagePeriod()?.range).toEqual({ from: 1, to: 2 });
    setPagePeriodDays(7);
    expect(getPagePeriod()).toEqual({ days: 7, range: null });
  });

  it('подписчики уведомляются на каждой смене — на этом держится общий период у всех сетей', () => {
    const seen: unknown[] = [];
    subscribePagePeriod(() => seen.push(getPagePeriod()));
    setPagePeriodDays(90);
    setPagePeriodRange({ from: 10, to: 20 }, 90);
    expect(seen).toEqual([
      { days: 90, range: null },
      { days: 90, range: { from: 10, to: 20 } },
    ]);
  });

  describe('разбор сохранённого', () => {
    it('валидное значение восстанавливается целиком', () => {
      expect(parsePagePeriod('{"days":90,"range":{"from":5,"to":9}}')).toEqual({
        days: 90,
        range: { from: 5, to: 9 },
      });
    });

    it('«Всё» (0) — валидный пресет, а не «пусто»', () => {
      expect(parsePagePeriod('{"days":0,"range":null}')).toEqual({ days: 0, range: null });
    });

    for (const [name, raw] of [
      ['мусор', 'not json'],
      ['пусто', ''],
      ['чужой days', '{"days":45}'],
      ['days строкой', '{"days":"30"}'],
      ['не объект', '"30"'],
    ] as const) {
      it(`${name} → null, а не молчаливый дефолт`, () => {
        expect(parsePagePeriod(raw)).toBeNull();
      });
    }

    it('половинчатый или перевёрнутый диапазон отбрасывается, пресет остаётся', () => {
      expect(parsePagePeriod('{"days":30,"range":{"from":5}}')).toEqual({ days: 30, range: null });
      expect(parsePagePeriod('{"days":30,"range":{"from":9,"to":5}}')).toEqual({ days: 30, range: null });
    });
  });
});
