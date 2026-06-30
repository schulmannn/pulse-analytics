import { describe, expect, it } from 'vitest';
import { cityName, countryName } from '@/lib/igMetrics';

describe('geo normalization', () => {
  it('cityName keeps the city and drops the region', () => {
    expect(cityName('London, England')).toBe('London');
    expect(cityName('Yekaterinburg, Sverdlovsk Oblast')).toBe('Yekaterinburg');
    expect(cityName('Москва, Москва')).toBe('Москва');
  });

  it('countryName resolves a code and passes non-codes through', () => {
    expect(countryName('US')).toBeTruthy();
    expect(countryName('Россия')).toBe('Россия');
  });
});
