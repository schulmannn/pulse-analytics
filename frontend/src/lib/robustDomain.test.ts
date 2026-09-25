import { describe, expect, it } from 'vitest';
import { MIN_POINTS_FOR_CLIP, sparkDomain } from '@/lib/robustDomain';

const flat = Array.from({ length: 20 }, (_, i) => 100 + (i % 3));

describe('sparkDomain', () => {
  it('оставляет честный min–max, когда выброса нет', () => {
    const d = sparkDomain(flat);
    expect(d.clipped).toEqual([]);
    expect(d.max).toBe(Math.max(...flat));
  });

  // Ровно наш прод-кейс: пик в 8.2 раза выше медианы прижимал 90% точек ко дну.
  it('срезает домен по выбросу и отмечает клипнутые точки', () => {
    const spiky = [...flat, 900];
    const d = sparkDomain(spiky);
    expect(d.clipped).toEqual([spiky.length - 1]);
    expect(d.max).toBeLessThan(900);
    expect(d.max).toBeGreaterThanOrEqual(Math.max(...flat));
  });

  // На 7–14 днях выброс — это и есть сюжет, а не помеха.
  it('не клипает короткое окно', () => {
    const short = [10, 10, 11, 10, 12, 10, 900];
    expect(short.length).toBeLessThan(MIN_POINTS_FOR_CLIP);
    expect(sparkDomain(short).clipped).toEqual([]);
    expect(sparkDomain(short).max).toBe(900);
  });

  it('не клипает, когда медиана нулевая — отношение не определено', () => {
    const mostlyZero = [...Array.from({ length: 19 }, () => 0), 500];
    expect(sparkDomain(mostlyZero).clipped).toEqual([]);
  });

  it('не клипает плато наверху — клип ничего не откроет', () => {
    const plateau = [...Array.from({ length: 10 }, () => 1), ...Array.from({ length: 10 }, () => 900)];
    expect(sparkDomain(plateau).clipped).toEqual([]);
  });

  it('никогда не меняет сами значения — режется только окно просмотра', () => {
    const spiky = [...flat, 900];
    const copy = [...spiky];
    sparkDomain(spiky);
    expect(spiky).toEqual(copy);
  });
});
